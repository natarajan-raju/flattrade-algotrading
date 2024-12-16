'use strict';
const { env } = require('@strapi/utils');


// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({

    async getPreferredContract(index,contractType,amount) {
        const contractTokens = strapi[`${index}`].get('contractTokens');
        const contracts = contractType === 'CE' ? contractTokens.ce : contractTokens.pe;
        let preferredContract = {token: null, lp: Infinity, tsym: null, lotSize: null};
        let smallestDifference = Infinity;
        contracts.forEach(contract => {
            if(contract.lp >= amount){
                const difference = Math.abs(contract.lp - amount);
                if(difference < smallestDifference){
                    smallestDifference = difference;
                    preferredContract = contract;
                }
            }
        });
        return preferredContract;
    },


    // Place BUY Order service
    async placeBuyOrder(orderData) {        
            const {  contractType, lp,quantity,index,indexToken, amount } = orderData;
            const preferredContract = await this.getPreferredContract(index,contractType,amount);
            
           
            
            if(preferredContract.token){
                const lotSize = quantity * preferredContract.ls;
                const price = lotSize * preferredContract.lp;
                
                const createdOrder = await strapi.db.query('api::order.order').create({
                    data: {
                        index,
                        orderType: 'BUY',
                        contractType,                       
                        contractToken: preferredContract.token,
                        indexLtp: lp,
                        contractTsym: preferredContract.tsym,
                        lotSize,
                        price,
                        contractLp: preferredContract.lp,                        
                    }               
                });
                console.log(`Created order: ${createdOrder}`);
                const contractBought = {
                    contractType,
                    contractToken: preferredContract.token,
                    tsym: preferredContract.tsym,
                    lotSize,                    
                }               
                strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType, contractToken: preferredContract.token,tsym: preferredContract.tsym,lotSize } });
                strapi[`${index}`].set('contractBought', contractBought);
                let awaitingOrderConfirmation = false;                
                strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });                                               
                

                strapi.webSocket.broadcast({
                    type: 'order',
                    data: createdOrder,
                    message: `Buy order for index ${index} with contract ${preferredContract.tsym} placed`,
                    status: 'success',
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
        
            const { contractType, lp, index, indexToken, quantity } = orderData;
            let contractBought;
            try{
                contractBought = strapi[`${index}`].get('contractBought');
            } catch(error){
                return {
                    status: false,
                    message: error
                }
            }
            if(!contractBought.tsym || contractBought.tsym === undefined || contractBought.tsym === '' || contractBought.tsym === null){
                return {
                    status: false,
                }
            }
            //Insert Flattrade Sell Execution code here
            const createdOrder = await strapi.db.query('api::order.order').create({
                data: {
                    index,
                    orderType: 'SELL',
                    contractType,
                    contractTsym: contractBought.tsym,
                    contractToken: contractBought.contractToken,
                    indexLtp: lp,
                    lotSize: contractBought.lotSize,
                    contractLp: 0,
                    price: 0,                                       
                }
            });
            console.log(`Created order: ${createdOrder}`);
            strapi.webSocket.broadcast({
                type: 'order',
                data: createdOrder,
                message: `Sell order for index ${index} with contract ${contractBought.contractTsym} placed`,
                status: true,
            });
            let awaitingOrderConfirmation = false;
            strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
            contractBought = {
                contractType: '',
                contractToken: '',
                tsym: '',
                lotSize: 0,
            }
            strapi[`${index}`].set('contractBought', contractBought);
            strapi.db.query('api::position.position').update({ where: { index }, data: { 
                contractType: '',
                contractToken: '',
                tsym: '',
                lotSize: 0 
            }});

           
            
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
