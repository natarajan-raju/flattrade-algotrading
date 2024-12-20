'use strict';
const { env } = require('@strapi/utils');
const contract = require('../../contract/controllers/contract');
// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({

    // Helper function to get the preferred token
    async getPreferredToken(contractTokens, contractType, targetAmount) {
        // Select the appropriate array based on contract type
        const tokensArray = contractType === 'CALL' ? contractTokens.call : contractTokens.put;
      
        // Find the token with the `lp` closest to `targetAmount`
        let closestTokenData = {token: null, lp: Infinity, tsym: null};
        let smallestDifference = Infinity;
      
        tokensArray.forEach(tokenData => {
          if(tokenData.lp > targetAmount){
            const difference = Math.abs(tokenData.lp - targetAmount);
            if (difference < smallestDifference) {
                smallestDifference = difference;
                closestTokenData = tokenData;
            }
          }         
        });      
        return closestTokenData; // Return token ID or null if not found
    }, 

    // Place BUY Order service
    async placeBuyOrder(orderData) {        
            const {  contractType, lp, contract, sessionToken, amount,quantity } = orderData;
            if (!contract ) {
                return {
                    status: false,
                    message: 'No Contract passed to placeBuyOrder. Check HandleFeed..',
                };
            }
            
            const preferredToken = await this.getPreferredToken(contract.contractTokens, contractType, amount);
            
            if(preferredToken.token){
                const lotSize = quantity * preferredToken.ls;
                const price = lotSize * preferredToken.lp;
                const contractBought = {
                    token: preferredToken.token,
                    contractType,
                    contractTsym: preferredToken.tsym,
                    contractId: contract.id,
                    lotSize,
                }
                const createdOrder = await strapi.db.query('api::order.order').create({
                    data: {
                        index: contract.index,
                        orderType: 'BUY',
                        contractType,                       
                        contractToken: preferredToken.token,
                        indexLtp: lp,
                        contractTsym: preferredToken.tsym,
                        lotSize,
                        price,
                        contractLp: preferredToken.lp,                        
                    }
                
                
                });
                
                await strapi.db.query('api::contract.contract').update({ where: { id: contract.id }, data: { contractBought } });
                strapi.webSocket.broadcast({
                    type: 'order',
                    data: createdOrder,
                    message: `Buy order for index ${contract.index} with contract ${preferredToken.tsym} placed`,
                    status: true,
                });
                return {
                    status: true,
                    message: 'Order placed successfully',
                    data: createdOrder
                }
            } else {
                return {
                    status: false,
                    message: 'No suitable tokens found for the order.'
                }
            }          
        
    },

    //Place SELL order Service
    async placeSellOrder(orderData) {
        
            const { contractType, lp,contract, sessionToken, index } = orderData;
            const contractToBeSold = await strapi.db.query('api::contract.contract').findOne({
                where: { index },
            });
            const contractLp = await strapi.service('api::contract.contract').getLpForOptionToken(contractToBeSold.contractBought.token,contract);
            //Insert Flattrade Sell Execution code here
            const createdOrder = await strapi.db.query('api::order.order').create({
                data: {
                    index,
                    orderType: 'SELL',
                    contractType,
                    contractTsym: contractToBeSold.contractBought.contractTsym,
                    contractToken: contractToBeSold.contractBought.token,
                    indexLtp: lp,
                    lotSize: contractToBeSold.contractBought.lotSize,
                    contractLp,
                    price: contractLp * contractToBeSold.contractBought.lotSize,                                       
                }
            });
            console.log(`Created order: ${createdOrder}`);
            await strapi.db.query('api::contract.contract').update({ where: { id: contractToBeSold.id }, data: {
                contractBought: {},
            } });
            strapi.webSocket.broadcast({
                type: 'order',
                data: createdOrder,
                message: `Sell order for index ${index} with contract ${contractToBeSold.contractBought.contractTsym} placed`,
                status: true,
            });
            return {
                status: true,
                message: 'Order placed successfully',
            }        
    },

    async handleOrderbookFeed(feedData){
        
            const { norenordno,prc,status } = feedData;
            const order = await strapi.db.query('api::order.order').findOne({
                where: { norenordno },
            });
            if(order){
                const updatedOrder = await strapi.db.query('api::order.order').update({ where: { id: order.id }, data: {
                    orderStatus: status,
                    prc,
                } 
                });
                strapi.webSocket.broadcast({                
                    type: 'order',
                    data: updatedOrder,
                    message: `Your order for index ${order.index} with contract ${order.contractTsym} has now a new status of ${status}`,
                    status: true,                   
                });
            }else{
                return {'status': false, message: 'Order not found'};
            }
            return {'status': true, message: 'Orderbook feed processed successfully'};
            
    },

}));
