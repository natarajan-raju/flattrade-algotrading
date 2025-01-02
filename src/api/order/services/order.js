'use strict';
const { env } = require('@strapi/utils');
const order = require('../controllers/order');


// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({

    async getPreferredContract(index,contractType,amount) {
        let contractTokens;
        
        if(strapi[`${index}`]?.get('contractTokens')){
            contractTokens = strapi[`${index}`].get('contractTokens');
        } else {
            return {message: 'Investment variables not entered for the day',token: null, lp: Infinity, tsym: null, lotSize: null}; 
        }
        
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
                const orderQuantity = quantity * preferredContract.ls;                
                let orderStatus;
                const norenordno = await this.placeOrderWithFlattrade('NFO',preferredContract.tsym,orderQuantity,'0','B','Order created from dashboard.rajaapp.in');
                if(norenordno){
                    orderStatus = await this.fetchOrderStatus(norenordno);
                    if(orderStatus){
                        console.log(orderStatus);
                        const price = parseFloat(orderStatus.qty) * parseFloat(orderStatus.avgprc);
                        const createdOrder = await strapi.db.query('api::order.order').create({
                            data: {
                                index,
                                orderType: 'BUY',
                                contractType,                       
                                contractTsym: orderStatus.tsym,
                                contractToken: orderStatus.token,
                                indexLtp: lp,
                                lotSize: parseInt(orderStatus.ls),
                                price: typeof price === 'number'? price : 0,
                                contractLp: parseFloat(orderStatus.avgprc) || preferredContract.lp,
                                norenordno,
                                orderStatus: orderStatus.status,
                                remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
                                indexToken,
                                quantity: parseInt(orderStatus.qty),
                                realizedPL: 0,                                                        
                            }               
                        });
                        console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);
                        if(orderStatus.status.toLowerCase() === 'complete'){
                            const contractBought = {
                                contractType,
                                contractToken: preferredContract.token,
                                tsym: preferredContract.tsym,
                                quantity: parseInt(orderStatus.qty),
                                costPrice: parseFloat(createdOrder.price) || price,                   
                            }
                            strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType, contractToken: preferredContract.token,tsym: preferredContract.tsym,lotSize: preferredContract.ls, quantity: orderStatus.qty, price } });
                            strapi[`${index}`].set('contractBought', contractBought);
                                                                           
                            

                            strapi.webSocket.broadcast({
                                type: 'order',
                                data: createdOrder,
                                message: `Buy order for index ${index} with contract ${preferredContract.tsym} placed`,
                                status: 'success',
                            });
                            let awaitingOrderConfirmation = false;
                            console.log('Order complete. Setting awaitingOrderConfirmation to false');                
                            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                            strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                            return {
                                status: true,
                                message: 'Order placed successfully',
                                data: createdOrder
                            }    

                        } else if(orderStatus.status.toLowerCase() === 'rejected'){
                            strapi.webSocket.broadcast({
                                type: 'order',
                                data: createdOrder,
                                message: `Buy order for index ${index} with contract ${preferredContract.tsym} rejected`,
                                status: 'failure',
                            });
                            let awaitingOrderConfirmation = false;  
                            console.log('Order rejected. Setting awaitingOrderConfirmation to false');              
                            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                            strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                            return {
                                status: false,
                                message: 'Order rejected',
                                data: createdOrder
                            }
                        }
                    }else{
                        strapi.webSocket.broadcast({
                            type: 'order',
                            data: null,
                            message: `Buy order for index ${index} with contract ${preferredContract.tsym} failed due to some error fetching order status from Flattrade`,
                            status: false,
                        });
                        let awaitingOrderConfirmation = false;  
                        console.log('Error fetching order status from Flattrade. Setting awaitingOrderConfirmation to false');              
                        strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                        strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                        return {
                            status: false,
                            message: 'Error fetching order status from Flattrade'
                        }
                    }
                }else {
                    strapi.webSocket.broadcast({
                        type: 'order',
                        data: null,
                        message: `Buy order for index ${index} with contract ${preferredContract.tsym} failed due to some error placing order with Flattrade`,
                        status: false,
                    });
                    let awaitingOrderConfirmation = false;
                    console.log('Error placing order with Flattrade. Setting awaitingOrderConfirmation to false');                
                    strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                    strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                    return {
                        status: false,
                        message: 'Error placing order with Flattrade'
                    }
                }
                let awaitingOrderConfirmation = false;                
                strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                console.log('Order placed successfully. Setting awaitingOrderConfirmation to false. This runs in case if any return is not handled above');
                strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });               
            } else {
                let awaitingOrderConfirmation = false;                
                strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                console.log('No suitable tokens found for the order. Setting awaitingOrderConfirmation to false');
                strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } }); 
                strapi.webSocket.broadcast({
                    type: 'order',
                    data: null,
                    message: `Buy order for index ${index} with contract ${preferredContract.tsym} failed as no suitable tokens found`,
                    status: 'failure',
                });
                return {
                    status: false,
                    message: 'No suitable tokens found for the order.'
                }
            }          
        
    },

    //Place SELL order Service
    async placeSellOrder(orderData) {
        
            const { contractType, lp, index, indexToken, quantity } = orderData;
            if(!contractType || !lp || !index || !indexToken || !quantity){
                return {
                    status: false,
                    message: 'Invalid payload provided'
                }
            }
            let contractBought;
            try{
                contractBought = strapi[`${index}`].get('contractBought');
            } catch(error){
                console.log('Error in fetching contract bought',error);
                return {
                    status: false,
                    message: error
                }
            }
            if(!contractBought.tsym || contractBought.tsym === undefined || contractBought.tsym === '' || contractBought.tsym === null){
                strapi.webSocket.broadcast({
                   type: 'order',
                   data: null,
                   message: `Sell order for index ${index} with contract ${contractBought.contractTsym} failed as no contract bought for this index`,
                   status: false,  
                });
                return {
                    status: false,
                    message: 'No contract bought for this index'
                }
            }
            //Insert Flattrade Sell Execution code here
            let orderStatus;
            const norenordno = await this.placeOrderWithFlattrade('NFO',contractBought.tsym,contractBought.quantity,'0','S','Order created from dashboard.rajaapp.in'   );
            if(norenordno){
                orderStatus = await this.fetchOrderStatus(norenordno);
                if(orderStatus){

                    const price = parseFloat(orderStatus.qty) * parseFloat(orderStatus.avgprc);
                    const realizedPL = price - contractBought.costPrice;  
                    const createdOrder = await strapi.db.query('api::order.order').create({
                        data: {
                            index,
                            orderType: 'SELL',
                            contractType,                       
                            contractTsym: orderStatus.tsym,
                            contractToken: orderStatus.token,
                            indexLtp: lp,
                            lotSize: parseInt(orderStatus.ls),
                            price: typeof price === 'number'? price : 0,
                            contractLp: parseFloat(orderStatus.avgprc),
                            norenordno,
                            orderStatus: orderStatus.status,
                            remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
                            indexToken,
                            quantity: parseInt(orderStatus.qty),
                            realizedPL,                        
                        }               
                    });
                    console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);
                    if(orderStatus.status.toLowerCase() === 'complete'){
                        const contractBought = {                                    
                        }
                        strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType: '', contractToken: '',tsym: '',lotSize: '', quantity: 0, price: 0 } });
                        strapi[`${index}`].set('contractBought', contractBought);                      

                        strapi.webSocket.broadcast({
                            type: 'order',
                            data: createdOrder,
                            message: `Buy order for index ${index} with contract ${orderStatus.tsym} placed`,
                            status: 'success',
                        });
                        let awaitingOrderConfirmation = false;  
                        console.log('Order complete. Setting awaitingOrderConfirmation to false');              
                        strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                        strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                        return {
                            status: true,
                            message: 'Order placed successfully',
                            data: createdOrder
                        }    

                    } else if(orderStatus.status.toLowerCase() === 'rejected'){
                        strapi.webSocket.broadcast({
                            type: 'order',
                            data: createdOrder,
                            message: `Buy order for index ${index} with contract ${orderStatus.tsym} rejected`,
                            status: 'failure',
                        });
                        let awaitingOrderConfirmation = false;                
                        strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                        console.log('Order rejected. Setting awaitingOrderConfirmation to false');
                        strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                        return {
                            status: false,
                            message: 'Order rejected',
                            data: createdOrder
                        }
                    }
                }else{
                    strapi.webSocket.broadcast({
                        type: 'order',
                        data: null,
                        message: `Buy order for index ${index} with contract ${orderStatus.tsym} failed due to some error fetching order status from Flattrade`,
                        status: false,
                    });
                    let awaitingOrderConfirmation = false;      
                    console.log('Error fetching order status from Flattrade. Setting awaitingOrderConfirmation to false');          
                    strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                    strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                    return {
                        status: false,
                        message: 'Error fetching order status from Flattrade'
                    }
                }
            }else {
                strapi.webSocket.broadcast({
                    type: 'order',
                    data: null,
                    message: `Buy order for index ${index} with contract ${contractBought.tsym} failed due to some error placing order with Flattrade`,
                    status: false,
                });
                let awaitingOrderConfirmation = false;                
                strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                console.log('Error placing order with Flattrade. Setting awaitingOrderConfirmation to false');
                strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                return {
                    status: false,
                    message: 'Error placing order with Flattrade'
                }
            }



            // const createdOrder = await strapi.db.query('api::order.order').create({
            //     data: {
            //         index,
            //         orderType: 'SELL',
            //         contractType,
            //         contractTsym: contractBought.tsym,
            //         contractToken: contractBought.contractToken,
            //         indexLtp: lp,
            //         lotSize: contractBought.lotSize,
            //         contractLp: 0,
            //         price: 0,                                       
            //     }
            // });
            // console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractTsym} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.lotSize} ${createdOrder.price} `);
            // strapi.webSocket.broadcast({
            //     type: 'order',
            //     data: createdOrder,
            //     message: `Sell order for index ${index} with contract ${contractBought.contractTsym} placed`,
            //     status: true,
            // });
            // let awaitingOrderConfirmation = false;
            // strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
            // strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
            // contractBought = {
            //     contractType: '',
            //     contractToken: '',
            //     tsym: '',
            //     lotSize: 0,
            // }
            // strapi[`${index}`].set('contractBought', contractBought);
            // strapi.db.query('api::position.position').update({ where: { index }, data: { 
            //     contractType: '',
            //     contractToken: '',
            //     tsym: '',
            //     lotSize: 0 
            // }});

           
            
            // return {
            //     status: true,
            //     message: 'Order placed successfully',
            // }        
    },

    async placeOrderWithFlattrade(exchange,tsym,quantity,price,orderType,remarks){
        
        try{
            
            const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","actid":"${env('FLATTRADE_ACCOUNT_ID')}","exch":"${exchange}","tsym":"${tsym}","qty":"${quantity}","prc":"${price}","prd":"M","trantype":"${orderType}","prctyp":"MKT","ret":"DAY","ordersource":"API","remarks":"${remarks}"}&jKey=${strapi.sessionToken}`;
            const orderResponse = await fetch(`${env('FLATTRADE_PLACE_ORDER_URL')}`,{
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: payload, 
            });
            const order = await orderResponse.json();
            if(order.norenordno){
                
                    
                return order.norenordno;
            } else {
                console.log(order);
                return null;
            }           
            
        }catch(error){
            console.log(error);
            return null;         
        }
    },

    // async handleOrderbookFeed(feedData){
        
    //         const { norenordno,prc,status, qty } = feedData;
    //         const order = await strapi.db.query('api::order.order').findOne({
    //             where: { norenordno },
    //         });
    //         if(order){
    //             const updatedOrder = await strapi.db.query('api::order.order').update({ where: { id: order.id }, data: {
    //                 orderStatus: status,
    //                 prc,
    //                 qty
    //             } 
    //             });
    //             strapi.webSocket.broadcast({                
    //                 type: 'order',
    //                 data: updatedOrder,
    //                 message: `Your order for index ${order.index} with contract ${order.contractTsym} has now a new status of ${status}`,
    //                 status: true,                   
    //             });
    //         }else{
    //             return {'status': false, message: 'Order not found'};
    //         }
    //         return {'status': true, message: 'Orderbook feed processed successfully'};
            
    // },

    async fetchOrderStatus(norenordno,retryCount=0,maxRetries=3){
        try{
            const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","norenordno":"${norenordno}"}&jKey=${strapi.sessionToken}`;
            const updateResponse = await fetch(`${env('FLATTRADE_ORDER_HISTORY_URL')}`,{
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: payload,
            });
            const orderStatusData = await updateResponse.json();
            const statusObject = orderStatusData.find(item =>
                item.status.toLowerCase() === "complete" || item.status.toLowerCase() === "rejected"
            );
            if (statusObject) {
                return statusObject;
            } else {
                if (retryCount < maxRetries) {
                    console.log(`Status is neither COMPLETE nor REJECTED. Retrying... (${retryCount + 1}/${maxRetries})`);
                    return await this.fetchOrderStatus(norenordno,retryCount + 1, maxRetries);
                } else {
                    console.log("Max retries reached. Aborting further attempts.");
                    return null;
                }
            }                                
        }catch(error){
            console.log(error);
            return null;                        
        }
    }

}));
