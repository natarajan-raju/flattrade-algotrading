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
        try {
            const {  contractType, lp, contract, sessionToken, amount,quantity } = orderData;
            if (!contract ) {
                return {
                    status: false,
                    message: 'No Contract passed to placeBuyOrder. Check HandleFeed..',
                };
            }
            console.log('test');
            const preferredToken = await this.getPreferredToken(contract.contractTokens, contractType, amount);
            console.log(preferredToken,preferredToken.lp);
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
        } catch (error) {
            return {
                status: false,
                message: error.message || 'An error occurred while placing the BUY order.'
            };
        }
    },

    //Place SELL order Service
    async placeSellOrder(orderData) {
        try{
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
            await strapi.db.query('api::contract.contract').update({ where: { id: contractToBeSold.id }, data: {
                contractBought: {},
            } });
            return {
                status: true,
                message: 'Order placed successfully',
            }
        }catch(error){
            return {
                status: false,
                message: error.message || 'An error occurred while placing the SELL order.'
            };
        }
    },

    async handleOrderbookFeed(feedData){
        try{
            const { norenordno,prc,status } = feedData;
            const order = await strapi.db.query('api::order.order').findOne({
                where: { norenordno },
            });
            if(order){
                await strapi.db.query('api::order.order').update({ where: { id: order.id }, data: {
                    orderStatus: status,
                    prc,
                } 
                });
            }else{
                return {'status': false, message: 'Order not found'};
            }
            return {'status': true, message: 'Orderbook feed processed successfully'};
             }catch(error){
                return {status: false, message: error || 'An error occurred while processing the orderbook feed.'};
        }
    },

}));
