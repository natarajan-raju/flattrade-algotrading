'use strict';
const { env } = require('@strapi/utils');
const order = require('../controllers/order');



// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({

    async getPreferredContract(index,contractType,amount,avoid = null) {
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
            //Skip the contract if it matches the avoid token
            if(contract.token === avoid) return;
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
        console.log(`Received for Buy Order: Contract Type: ${contractType} Quantity: ${quantity} Index: ${index} Amount: ${amount}`);
        let retry = 0;
        let avoid = '';
        do{            
            let preferredContract = await this.getPreferredContract(index,contractType,amount,avoid);
            if(preferredContract.token){
                console.log(`Found a suitable contract ${preferredContract.tsym} with price INR ${preferredContract.lp}`);
                const orderQuantity = quantity * preferredContract.ls;                
                let orderStatus;
                const norenordno = await this.placeOrderWithFlattrade('NFO',preferredContract.tsym,orderQuantity,'0','B','Order created from rajaapp.in');
                if(norenordno){
                    orderStatus = await this.fetchOrderStatus(norenordno);
                    if(orderStatus){
                        console.log(orderStatus);
                        let price;
                        orderStatus.avgprc? price = orderStatus.qty * orderStatus.avgprc : orderStatus.qty * preferredContract.lp;                           
                
                        if(orderStatus.status.toLowerCase() === 'complete'){
                            retry = 0;
                            const contractBought = {
                                contractType,
                                contractToken: preferredContract.token,
                                tsym: preferredContract.tsym,
                                quantity: parseInt(orderStatus.qty),
                                costPrice: price,                   
                            }
                            strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType, contractToken: preferredContract.token,tsym: preferredContract.tsym,lotSize: preferredContract.ls, quantity: orderStatus.qty, price } });
                            strapi[`${index}`].set('contractBought', contractBought);
                            strapi[`${index}`].set('profitStage', 0); 
                            strapi[`${index}`].set('downwardProfitTrigger', false);                              
                            strapi.webSocket.broadcast({
                                type: 'order',
                                data: orderStatus,
                                message: `Buy order for index ${index} with contract ${preferredContract.tsym} placed`,
                                status: 'success',
                            });
                            let awaitingOrderConfirmation = false;
                            console.log('Order complete. Setting awaitingOrderConfirmation to false');                
                            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                            strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                            try{
                                const createdOrder = await strapi.db.query('api::order.order').create({
                                    data: {
                                        index,
                                        orderType: 'BUY',
                                        contractType,                       
                                        contractTsym: orderStatus.tsym,
                                        contractToken: orderStatus.token,
                                        indexLtp: lp,
                                        lotSize: `${orderStatus.ls}`,
                                        price: `${price}`,
                                        contractLp: `${orderStatus.avgprc}` || `${preferredContract.lp}`,
                                        norenordno,
                                        orderStatus: orderStatus.status,
                                        remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
                                        indexToken,
                                        quantity: `${orderStatus.qty}`,
                                        realizedPL: '0',                                                        
                                    }               
                                });
                                console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);
                            }catch(error){
                                console.log(`Error in storing the order in database: ${error} `);                                    
                            };
                            
                            return {
                                status: true,
                                message: 'Order placed successfully',
                                data: orderStatus
                            }    

                        } else if(orderStatus.status.toLowerCase() === 'rejected'){                                   
                            let awaitingOrderConfirmation = false;  
                            console.log(`Order rejected for contract ${preferredContract.tsym} with reason ${orderStatus.rejreason}.. Setting awaitingOrderConfirmation to false`);              
                            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                            avoid = preferredContract.token;
                            retry++;                            
                            strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                            strapi.webSocket.broadcast({
                                type: 'order',
                                data: orderStatus,
                                message: `Buy order for index ${index} with contract ${preferredContract.tsym} rejected with reason ${orderStatus.rejreason}`,
                                status: 'failure',
                            });
                            try{
                                const createdOrder = await strapi.db.query('api::order.order').create({
                                    data: {
                                        index,
                                        orderType: 'BUY',
                                        contractType,                       
                                        contractTsym: orderStatus.tsym,
                                        contractToken: orderStatus.token,
                                        indexLtp: lp,
                                        lotSize: `${orderStatus.ls}`,
                                        price: '0',
                                        contractLp: '0',
                                        norenordno,
                                        orderStatus: orderStatus.status,
                                        remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
                                        indexToken,
                                        quantity: `${orderStatus.qty}`,
                                        realizedPL: '0',                                                        
                                    }               
                                });
                                console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);
                            }catch(error){
                                console.log(`Error in storing the order in database: ${error} `);                                    
                            };
                            if(retry === 1){
                                console.log('Buy order failed once. Retrying...');
                                continue;
                            } else if(retry > 1){
                                console.log('Buy order failed two times. Exiting buy attempt...');
                                return {
                                    status: false,
                                    message: 'Order rejected',
                                    data: orderStatus
                                }
                            } else {
                                break;
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
                        retry++;
                        break;
                        // return {
                        //     status: false,
                        //     message: 'Error fetching order status from Flattrade'
                        // }
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
                    retry++;
                    break;
                    // return {
                    //     status: false,
                    //     message: 'Error placing order with Flattrade'
                    // }
                }
                // let awaitingOrderConfirmation = false;                
                // strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                // console.log('Order placed successfully. Setting awaitingOrderConfirmation to false. This runs in case if any return is not handled above');
                // strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });               
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
                retry++;
                break;
                // return {
                //     status: false,
                //     message: 'No suitable tokens found for the order.'
                // }
            }
                // try{            
                            
                // }catch(error){                
                //     let awaitingOrderConfirmation = false;                
                //     strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                //     console.log(`Error in placeBuyOrder: ${error}. Setting awaitingOrderConfirmation to false`);
                //     strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } }); 
                //     strapi.webSocket.broadcast({
                //         type: 'order',
                //         data: null,
                //         message: `Buy order for index ${index} with contract ${preferredContract.tsym} failed due to some error in placeBuyOrder: ${error}`,
                //         status: 'failure',
                //     });
                //     retry++;
                //     break;
                //     // return {
                //     //     status: false,
                //     //     message: 'Error in placeBuyOrder'
                //     // }
                // }
        }while(retry > 0 && retry <= 1);
        return {
            status: false,
            message: 'Error placing order with Flattrade'
        }        
    },

    //Place SELL order Service
    async placeSellOrder(orderData) {
        
            const { lp, index, indexToken, quantity } = orderData;
            if( !lp || !index || !indexToken || !quantity){
                return {
                    status: false,
                    message: 'Invalid payload provided'
                }
            }
            
            let contractBought;
            let contractType;
            try{
                contractBought = strapi[`${index}`].get('contractBought');
                console.log(`Received sell order for ${JSON.stringify(contractBought)}`);
                contractType = contractBought.contractType;            
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
                        console.log(orderStatus);                        
                        const price = orderStatus.qty * orderStatus.avgprc;
                        const realizedPL = price - contractBought.costPrice;  
                        
                        if(orderStatus.status.toLowerCase() === 'complete'){
                            const contractBought = {                                    
                            }
                            strapi[`${index}`].set('stopLossThreshold', 0);   
                            strapi[`${index}`].set('profitThreshold', Infinity); 
                            strapi[`${index}`].set('downwardProfitTrigger', false); 
                            strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType: '', contractToken: '',tsym: '',lotSize: '', quantity: 0, price: 0 } });
                            strapi[`${index}`].set('contractBought', contractBought);
                            // console.log(`Order complete, Contract bought reset: ${strapi[`index`].get('contractBought')}`);                      

                            strapi.webSocket.broadcast({
                                type: 'order',
                                data: orderStatus,
                                message: `Sell order for index ${index} with contract ${orderStatus.tsym} placed`,
                                status: 'success',
                            });
                            let awaitingOrderConfirmation = false; 
                            console.log('Order complete. Setting awaitingOrderConfirmation to false');              
                            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                            strapi[`${indexToken}`].set('callOptionBought', false);
                            strapi[`${indexToken}`].set('callBoughtAt', 0);
                            strapi[`${indexToken}`].set('putOptionBought', false);
                            strapi[`${indexToken}`].set('putBoughtAt', 0); 
                            let initialSpectatorMode = true; 
                            strapi[`${indexToken}`].set('initialSpectatorMode', initialSpectatorMode);        
                            strapi.db.query('api::variable.variable').update(
                                { where: { indexToken },
                                    data: { 
                                        awaitingOrderConfirmation,
                                        callOptionBought: false,
                                        putOptionBought: false,
                                        callBoughtAt: 0,
                                        putBoughtAt: 0,
                                        initialSpectatorMode
                                    } 
                                });
                            try{
                                const createdOrder = await strapi.db.query('api::order.order').create({
                                    data: {
                                        index,
                                        orderType: 'SELL',
                                        contractType,                       
                                        contractTsym: orderStatus.tsym,
                                        contractToken: orderStatus.token,
                                        indexLtp: lp,
                                        lotSize: `${orderStatus.ls}`,
                                        price: `${price}`,
                                        contractLp: `${orderStatus.avgprc}`,
                                        norenordno,
                                        orderStatus: orderStatus.status,
                                        remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
                                        indexToken,
                                        quantity: `${orderStatus.qty}`,
                                        realizedPL: `${realizedPL}`,                        
                                    }               
                                });
                                console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);                               
                            }catch(error){
                                console.log(`Error in storing the order in database: ${error}`);
                            };
                            return {
                                status: true,
                                message: 'Order placed successfully',
                                data: orderStatus
                            }    

                        } else if(orderStatus.status.toLowerCase() === 'rejected'){
                            strapi.webSocket.broadcast({
                                type: 'order',
                                data: orderStatus,
                                message: `Sell order for index ${index} with contract ${orderStatus.tsym} rejected`,
                                status: 'failure',
                            });
                            const position = await this.checkOpenPosition(orderStatus.tsym);
                            if(!position){
                                console.log(`No open position for the contract with quantity ${contractBought.quantity}. Might be the case the position is squared off manually`);
                                const contract = {                                  
                                };
                                strapi[`${index}`].set('contractBought',contract);
                                strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType: '', contractToken: '',tsym: '',lotSize: '', quantity: 0, price: 0 } });
                                let awaitingOrderConfirmation = false;                                         
                                strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                                strapi[`${indexToken}`].set('callOptionBought', false);
                                strapi[`${indexToken}`].set('callBoughtAt', 0);
                                strapi[`${indexToken}`].set('putOptionBought', false);
                                strapi[`${indexToken}`].set('putBoughtAt', 0);
                                let initialSpectatorMode = true; 
                                strapi[`${indexToken}`].set('initialSpectatorMode', initialSpectatorMode);                                                        
                                strapi.db.query('api::variable.variable').update(
                                    { where: { indexToken },
                                        data: { 
                                            awaitingOrderConfirmation,
                                            callOptionBought: false,
                                            putOptionBought: false,
                                            callBoughtAt: 0,
                                            putBoughtAt: 0,
                                            initialSpectatorMode
                                        } 
                                    });
                                    strapi.webSocket.broadcast({
                                        type: 'action',                                    
                                        message: `rajaapp.in has found no open position for the contract with quantity ${contractBought.quantity} vs actual open position quantity ${position.opensellqty}`,
                                        status: 'failure',
                                    });                                
                            }                            
                            let awaitingOrderConfirmation = false;                
                            strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                            console.log('Order rejected. Setting awaitingOrderConfirmation to false');
                            strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
                            try{
                                const createdOrder = await strapi.db.query('api::order.order').create({
                                    data: {
                                        index,
                                        orderType: 'SELL',
                                        contractType,                       
                                        contractTsym: orderStatus.tsym,
                                        contractToken: orderStatus.token,
                                        indexLtp: lp,
                                        lotSize: `${orderStatus.ls}`,
                                        price: '0',
                                        contractLp: '0',
                                        norenordno,
                                        orderStatus: orderStatus.status,
                                        remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
                                        indexToken,
                                        quantity: `${orderStatus.qty}`,
                                        realizedPL: '0',                        
                                    }               
                                });
                                console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);                               
                            }catch(error){
                                console.log(`Error in storing the order in database: ${error}`);
                            };
                            return {
                                status: false,
                                message: 'Order rejected',
                                data: orderStatus
                            }
                        }
                    }else{
                        strapi.webSocket.broadcast({
                            type: 'order',
                            data: null,
                            message: `Sell order for index ${index} with contract ${orderStatus.tsym} failed due to some error fetching order status from Flattrade`,
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
                        message: `Sell order for index ${index} with contract ${contractBought.tsym} failed due to some error placing order with Flattrade`,
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
            } catch(error){
                let awaitingOrderConfirmation = false;                
                strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                console.log(`Error in placeSellOrder: ${error}. Setting awaitingOrderConfirmation to false`);
                strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } }); 
                strapi.webSocket.broadcast({
                    type: 'order',
                    data: null,
                    message: `Sell order for index ${index} failed due to some error in placeSellOrder: ${error}`,
                    status: 'failure',
                });
                return {
                    status: false,
                    message: 'Error in placeBuyOrder'
                }
            }    
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

    async checkOpenPosition(tsym){
        try{            
            const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","actid":"${env('FLATTRADE_ACCOUNT_ID')}"}&jKey=${strapi.sessionToken}`;
            const positionBookResponse = await fetch(`${env('FLATTRADE_POSITION_BOOK_URL')}`,{
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: payload,
            });
            const positionBook = await positionBookResponse.json();
            console.log(positionBook);
            if(Array.isArray(positionBook) && positionBook.length > 0){
                const position = positionBook.find(position => position.tsym === tsym && position.opensellqty > 0);
                if(position){
                    console.log(`Available position for ${tsym}: ${JSON.stringify(position)}`);
                    return position;
                }else{
                    console.log(`No available position for ${tsym}`);
                    return null;
                }
            }else{
                console.log('Error fetching position book');
                return null;
            }
        }catch(error){
            console.log(error);
            return null;
        }
    },

    async handleOrderbookFeed(feedData){
            console.log(feedData);
            const { norenordno,prc,status, qty } = feedData;
            const order = await strapi.db.query('api::order.order').findOne({
                where: { norenordno },
            });
            if(order){
                const updatedOrder = await strapi.db.query('api::order.order').update({ where: { id: order.id }, data: {
                    orderStatus: status,
                    prc,
                    qty
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
