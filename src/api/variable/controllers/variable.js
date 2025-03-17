'use strict';

const index = require('@strapi/plugin-users-permissions/strapi-admin');
const { env } = require('@strapi/utils');


/**
 * variable controller
 */

// @ts-ignore
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::variable.variable', ({ strapi }) => ({
    //Handle Update request
    async handleInvestmentVariables(ctx) {
        

        //Check input values        
        const {
          basePrice,          
          resistance1,
          resistance2,
          support1,
          support2,
          indexToken,
          amount,
          expiry,
          quantity,
          open
        } = ctx.request.body;        
        if (!open ||!quantity || !expiry || !amount || !indexToken || indexToken.length === 0 || !basePrice || !resistance1 || !resistance2 || !support1 || !support2) {
            return ctx.send({ message: 'Invalid Payload provided. Please fill all the fields...', status: false, });
        } else if(open <= 0 || quantity <= 0 || amount <= 0 || basePrice <=0 || resistance1 <=0 || resistance2 <=0 || support1 <=0 || support2 <=0){
            return ctx.send({ message: 'Cannot provide zero or negative values for mandatory fields...', status: false });
        }


        
        //Check if a variable row exist in the database for the given token
        const indexItem = await strapi.db.query('api::variable.variable').findOne({
            where: { indexToken },  
        });
        if(!indexItem){
            return ctx.send({ message: 'Please check the token provided...', status: false });
        }
        let contracts;

        
        
        //Check if a session Token exist in            
        await strapi.service('api::authentication.authentication').fetchRequestToken();
        if(!strapi.sessionToken){
            return ctx.send({ message: 'Request token not found', status: false });
        }
        // console.log(strapi.sessionToken);
        //Check expiry data by submitting a random contract detail fetch with the given expiry date to Flattrade
        try{            
            const date = await strapi.service('api::variable.variable').convertDateFormat(expiry);
            const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","stext":"${indexItem.index + date}","exch":"NFO"}&jKey=${strapi.sessionToken}`;
            const contractsResponse = await fetch(`${env('FLATTRADE_SEARCH_SCRIP_URL')}`,{
                method: 'POST',
                headers: {
                          'Content-Type': 'application/json'
                        },
                body: payload, 
            });
            contracts = await contractsResponse.json();                                    
            // console.log(contracts);
            if(!contracts.values || contracts.values.length == 0 ){
                return ctx.send({ message: 'Either expiry data provided is wrong or Session token expired', status: false });
            }
        } catch (error) {
            return ctx.send({ message: 'Either expiry data provided is wrong or Session token expired',error: error, status: false });
        }        
       
   

              
        // Step 2: Update values for the found index
        const updatedIndexItem = await strapi.db.query('api::variable.variable').update({
            where: { indexToken },  
            data: {
            open,    
            basePrice,
            resistance1,
            resistance2,
            support1,
            support2,
            expiry,
            amount, // Store the investment amount
            quantity,
            callOptionBought: false,
            putOptionBought: false,           
            initialSpectatorMode: true,
            previousTradedPrice: 0,
            callBoughtAt: 0,
            putBoughtAt: 0,
            awaitingOrderConfirmation: false,
            },
        });
        strapi[`${indexToken}`] = new Map(Object.entries(updatedIndexItem));
        console.table(updatedIndexItem);
        strapi[`${indexToken}`].set('index', indexItem.index);
        strapi[`${indexToken}`].set('buyCall',true);
        strapi[`${indexToken}`].set('buyPut',true);
        strapi[`${indexToken}`].set('eod',indexItem.eod);
        // strapi.service('api::variable.variable').analyzeMarketDirection(indexToken);    

        strapi[`${indexItem.index}`] = new Map();
        

        let scripList;
        //Find if a scripList is already subscribed for the given token or generate scripList and subscribe to Flattrade websocket
        let scripItem = await strapi.db.query('api::web-socket.web-socket').findOne({where: { indexToken }});    
        if(!scripItem.scripList){
            try{
                scripList = await strapi.service('api::variable.variable').processScripList(indexToken,indexItem.index,contracts.values[0].tsym, strapi.sessionToken);  
                strapi[`${indexToken}`].set('scripList', scripList);                    
            }catch(error){
                return ctx.send({ message: `Error in processing scrip list with error:  ${error}`, status: false });
            }
        } else {
            scripList = scripItem.scripList;           
            let contract = await strapi.db.query('api::contract.contract').findOne({where: {indexToken}});            
            strapi[`${indexItem.index}`].set('contractTokens', contract.contractTokens);

        }
        // Find all other scripLists and concatenate them with the current scripList using '#'
        let otherScripItems = await strapi.db.query('api::web-socket.web-socket').findMany({
            where: { 
                indexToken: { $ne: indexToken } // Exclude the current indexToken
            },
            select: ['scripList'], // Select only the scripList field
        });

        if (otherScripItems && otherScripItems.length > 0) {
            for (const otherScripItem of otherScripItems) {
                if (otherScripItem.scripList) {
                    scripList += `#${otherScripItem.scripList}`; // Concatenate with '#'
                }
            }
        }
        
        await strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket(scripList);
        console.table(`Base Price: ${basePrice}, Resistance 1: ${resistance1}, Resistance 2: ${resistance2}, Support 1: ${support1}, Support 2: ${support2}`);
        
        try {
            strapi.service('api::variable.variable').startMarketAnalysis(indexToken);
            // await strapi.service('api::variable.variable').analyzeMarketDirection(indexToken);
          } catch (error) {
            console.log(error);
          }
                
        return {
            message: `Investment variables updated successfully. Market watching started for index ${indexItem.index}.`,
            status: true,
            updatedIndexItem,            
        }
    },

    //Stop Trading
    async stopTrading(ctx) {
        const { indexToken } = ctx.request.body;
        return ctx.send(await strapi.service('api::variable.variable').stopTrading(indexToken));
    },
    
    //Get Time price data from Flattrade
    async getTimePriceData(ctx) {
        try{
        const { indexToken, interval, days } = ctx.request.body;
        
        // Calculate startDate and interval based on days
        const currentDate = new Date();
        let calculatedInterval = interval;
        let calculatedStartDate;
    
        if (days) {
            const dayToMs = 24 * 60 * 60 * 1000; // Milliseconds in a day
            calculatedStartDate = new Date(currentDate.getTime() - days * dayToMs);
            
            // Set default intervals based on the days
            switch (days) {
                case 1:
                    calculatedInterval = interval || 1;
                    break;
                case 5:
                    calculatedInterval = interval || 5;
                    break;
                case 30:
                    calculatedInterval = interval || 30;
                    break;
                case 90:
                    calculatedInterval = interval || 60;
                    break;
                case 180:
                    calculatedInterval = interval || 120;
                    break;
                default:
                    calculatedInterval = interval || 1; // Default to 1 if no match
            }
        }else {
                // If days are not provided, default to today's date
                calculatedStartDate = new Date(currentDate);
                calculatedStartDate.setHours(0, 0, 0, 0);
                calculatedInterval = interval || 1; // Default interval is 1
        }
        
            // Pass the calculated startDate and interval to the service
            return ctx.send(await strapi.service('api::variable.variable').getTimePriceData(
                indexToken,
                calculatedInterval,
                calculatedStartDate.toISOString()
            ));
        }catch(error){
            return ctx.send({ message: `Error in getting time price data with error:  ${error}`, status: false });
        }
    },

      //Custom controller function to handle Amount based Algorthmic trading
      async startAmountBasedTrading(ctx) {
        try {
          const { entry, target, stopLoss, indexToken, expiry } = ctx.request.body;
          ctx.send(`Amount based trading started with Entry price ${entry} `);
          console.log("Amount-based trading started with:", { entry, target, stopLoss, indexToken, expiry });
    
        //   // 1. Check if current time is between 9:15 and 9:30
        //   if (!isBetween915And930()) {
        //     return ctx.send("Trading can only start between 9:15 and 9:30 AM.");
        //   }    
          const indexItem =await strapi.db.query('api::variable.variable').findOne({where: {indexToken}});
          const index = indexItem.index;
          try{
            strapi[`${indexToken}`] && console.log(strapi[`${indexToken}`]);
          }catch(error){
            console.log(error);
            strapi[`${indexToken}`] = new Map(Object.entries(indexItem));
            console.log('TEst',strapi[`${indexToken}`].index);
    
          }
          // console.log(indexItem);
          let avoid = null;    
          let preferredCall = null; 
          let preferredPut = null; 
          let callInitialLP = null; 
          let putInitialLP = null;    
          let chosenContract = null; // The contract that eventually breaches +0.9
          let scripList;
          let contracts = {};
          let contract = await strapi.db.query('api::contract.contract').findOne({where: {indexToken}})?.sampleContractTsym || null;
          console.log(`Available Sample contract for ${indexToken}: ${contract}`);
          if(!contract){
            console.log(`No available Sample contract for ${indexToken}. Hence trying to fetch new contract for ${indexToken}`);
            try{            
              const date = await strapi.service('api::variable.variable').convertDateFormat(expiry);
              const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","stext":"${index + date}","exch":"NFO"}&jKey=${strapi.sessionToken}`;
              console.log(payload);
              const contractsResponse = await fetch(`${env('FLATTRADE_SEARCH_SCRIP_URL')}`,{
                  method: 'POST',
                  headers: {
                            'Content-Type': 'application/json'
                          },
                  body: payload, 
              });
              contracts = await contractsResponse.json();                                                  
              // console.log(contracts);
              if(!contracts.values || contracts.values.length == 0 ){
                  return ctx.send({ message: 'Either expiry data provided is wrong or Session token expired', status: false });
              }
              contract = contracts.values[0].tsym;
              console.log(`Available Sample contract for ${indexToken}: ${contract}. Processing Scrip list......`);
          } catch (error) {
              return ctx.send({ message: 'Either expiry data provided is wrong or Session token expired',error: error, status: false });
          }
        }


          //Find if a scripList is already subscribed for the given token or generate scripList and subscribe to Flattrade websocket
          let scripItem = await strapi.db.query('api::web-socket.web-socket').findOne({where: { indexToken }});    
          if(!scripItem.scripList){
              try{
                  scripList = await strapi.service('api::variable.variable').processScripList(indexToken,index,contract, strapi.sessionToken);  
                  strapi[`${indexToken}`].set('scripList', scripList);                    
              }catch(error){
                  return ctx.send({ message: `Error in processing scrip list with error:  ${error}`, status: false });
              }
          } else {
              scripList = scripItem.scripList;           
              let contract = await strapi.db.query('api::contract.contract').findOne({where: {indexToken}});            
              strapi[`${index}`].set('contractTokens', contract.contractTokens);

          }
          // Find all other scripLists and concatenate them with the current scripList using '#'
          let otherScripItems = await strapi.db.query('api::web-socket.web-socket').findMany({
              where: { 
                  indexToken: { $ne: indexToken } // Exclude the current indexToken
              },
              select: ['scripList'], // Select only the scripList field
          });

          if (otherScripItems && otherScripItems.length > 0) {
              for (const otherScripItem of otherScripItems) {
                  if (otherScripItem.scripList) {
                      scripList += `#${otherScripItem.scripList}`; // Concatenate with '#'
                  }
              }
          }
          
          await strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket(scripList);
    
          // 2. We'll keep searching/monitoring until one contract hits +0.9
          //    or until the time window (9:15–9:30) ends.
          while (true) {
            // // Stop if time is >= 9:30
            // if (!await strapi.service("api::variable.variable").isBetween915And930()) {
            //   console.log("Time window ended (after 9:30). Stopping search/monitoring.");
            //   break;
            // }
    
            // Try to find a CALL contract if we don't have one yet
            if (!preferredCall) {
              const callCandidate = await strapi
                .service("api::order.order")
                .getPreferredContract(index, "CALL", entry, avoid);
              if (callCandidate?.token) {
                preferredCall = callCandidate;
                callInitialLP = callCandidate.lp;
                console.log("Found CALL contract:", callCandidate.token, "LP =", callCandidate.lp);
              }
            }
    
            // Try to find a PUT contract if we don't have one yet
            if (!preferredPut) {
              const putCandidate = await strapi
                .service("api::order.order")
                .getPreferredContract(index, "PUT", entry, avoid);
              if (putCandidate?.token) {
                preferredPut = putCandidate;
                putInitialLP = putCandidate.lp;
                console.log("Found PUT contract:", putCandidate.token, "LP =", putCandidate.lp);
              }
            }
    
            // If we have at least one contract, let's monitor it (them).
            // If neither is found yet, just wait a bit and keep trying until 9:30 or we find something.
            if (!preferredCall && !preferredPut) {
              await strapi.service("api::variable.variable").sleep(2000);
              continue;
            }
    
            // 3. Refresh the LP for whichever contracts we have and see if it increased by >= 0.9
            //    We'll do a short loop (or direct checks) so we don't hammer the service too much.
            for (let i = 0; i < 3; i++) {
            //   if (!strapi.service("api::variable.variable").isBetween915And930()) {
            //     console.log("Time window ended mid-loop (after 9:30). Stopping.");
            //     break;
            //   }
    
              // Refresh CALL if we have it
              if (preferredCall) {
                const callRefreshedLP = strapi[`${preferredCall.token}`].get("lp");
                const callGain = callRefreshedLP - callInitialLP;
                preferredCall.lp = callRefreshedLP;
                console.log("CALL updated LP:", callRefreshedLP, "Gain:", callGain.toFixed(2));
                if (callGain >= 0.9) {
                  chosenContract = preferredCall;
                  console.log("CALL contract gained +0.9. Chosen:", chosenContract.token);
                  break;
                }
              }
    
              // Refresh PUT if we have it
              if (preferredPut) {
                const putRefreshedLP = strapi[`${preferredPut.token}`].get("lp");
                const putGain = putRefreshedLP - putInitialLP;  
                preferredPut.lp = putRefreshedLP;              
                console.log("PUT updated LP:", putRefreshedLP, "Gain:", putGain.toFixed(2));
                if (putGain >= 0.9) {
                  chosenContract = preferredPut;
                  console.log("PUT contract gained +0.9. Chosen:", chosenContract.token);
                  break;
                }
              }
    
              // If neither gained 0.9 in this pass, wait & try again
              await strapi.service("api::variable.variable").sleep(1500);
            }
    
            // If we found a contract that hit +0.9, break out entirely
            if (chosenContract) {
                strapi.webSocket.broadcast({
                    type: 'action',
                    message: `Application believes ${chosenContract.tsym} with current LP ${chosenContract.lp} will give profit by reaching a LP of ${target}`,
                    status: true
                });
                strapi.chosenContract = chosenContract;
                break;
            }
    
            // If still no chosen contract, wait a bit before next big iteration
            await strapi.service("api::variable.variable").sleep(2000);
          }
    
          // 4. If we ended with a chosen contract, place bracket order
        //   if (chosenContract) {

            //     console.log(`Found a suitable contract ${chosenContract.tsym} with price INR ${chosenContract.lp}}`);
            //     const orderQuantity = preferredContract.ls;                
            //     let orderStatus;
            //     let bracketOrder = true;
            //     const norenordno = await this.placeOrderWithFlattrade('NFO',chosenContract.tsym,orderQuantity,'0','B','Order created from rajaapp.in',bracketOrder,target,stopLoss);
            //     if(norenordno){
            //         orderStatus = await this.fetchOrderStatus(norenordno);
            //         if(orderStatus){
            //             console.table(orderStatus);
            //             let price;
            //             orderStatus.avgprc? price = orderStatus.qty * orderStatus.avgprc : orderStatus.qty * chosenContract.lp;                           
                
            //             if(orderStatus.status.toLowerCase() === 'complete'){                            
                                                       
            //                 strapi.webSocket.broadcast({
            //                     type: 'order',
            //                     data: orderStatus,
            //                     message: `Buy order for index ${index} with contract ${chosenContract.tsym} placed`,
            //                     status: 'success',
            //                 });                            
            //                 try{
            //                     const createdOrder = await strapi.db.query('api::order.order').create({
            //                         data: {
            //                             index,
            //                             orderType: 'BUY',
            //                             contractType,                       
            //                             contractTsym: orderStatus.tsym,
            //                             contractToken: orderStatus.token,
            //                             indexLtp: lp,
            //                             lotSize: `${orderStatus.ls}`,
            //                             price: `${price}`,
            //                             contractLp: `${orderStatus.avgprc}` || `${preferredContract.lp}`,
            //                             norenordno,
            //                             orderStatus: orderStatus.status,
            //                             remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
            //                             indexToken,
            //                             quantity: `${orderStatus.qty}`,
            //                             realizedPL: '0',                                                        
            //                         }               
            //                     });
            //                     // console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);
            //                 }catch(error){
            //                     console.log(`Error in storing the order in database: ${error} `);                                    
            //                 };
                            
            //                 return {
            //                     status: true,
            //                     message: 'Order placed successfully',
            //                     data: orderStatus
            //                 }    

            //             } else if(orderStatus.status.toLowerCase() === 'rejected'){                                   
            //                 let awaitingOrderConfirmation = false;  
            //                 // console.log(`Order rejected for contract ${preferredContract.tsym} with reason ${orderStatus.rejreason}.. Setting awaitingOrderConfirmation to false`);              
            //                 strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
            //                 avoid = preferredContract.token;
            //                 retry++;                            
            //                 strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
            //                 strapi.webSocket.broadcast({
            //                     type: 'order',
            //                     data: orderStatus,
            //                     message: `Buy order for index ${index} with contract ${preferredContract.tsym} rejected with reason ${orderStatus.rejreason}`,
            //                     status: 'failure',
            //                 });
            //                 try{
            //                     const createdOrder = await strapi.db.query('api::order.order').create({
            //                         data: {
            //                             index,
            //                             orderType: 'BUY',
            //                             contractType,                       
            //                             contractTsym: orderStatus.tsym,
            //                             contractToken: orderStatus.token,
            //                             indexLtp: lp,
            //                             lotSize: `${orderStatus.ls}`,
            //                             price: '0',
            //                             contractLp: '0',
            //                             norenordno,
            //                             orderStatus: orderStatus.status,
            //                             remarks: orderStatus.rejreason.length > 0? orderStatus.rejreason : orderStatus.remarks,
            //                             indexToken,
            //                             quantity: `${orderStatus.qty}`,
            //                             realizedPL: '0',                                                        
            //                         }               
            //                     });
            //                     // console.log(`Created order: ${createdOrder.index} ${createdOrder.orderType} ${createdOrder.contractType} ${createdOrder.contractToken} ${createdOrder.indexLtp} ${createdOrder.contractTsym} ${createdOrder.quantity} ${createdOrder.price} ${createdOrder.contractLp}`);
            //                 }catch(error){
            //                     console.log(`Error in storing the order in database: ${error} `);                                    
            //                 };
            //                 if(retry === 1){
            //                     console.log('Buy order failed once. Retrying...');
            //                     continue;
            //                 } else if(retry > 1){
            //                     console.log('Buy order failed two times. Exiting buy attempt...');
            //                     return {
            //                         status: false,
            //                         message: 'Order rejected',
            //                         data: orderStatus
            //                     }
            //                 } else {
            //                     break;
            //                 }                                    
            //             }                        
            //         }else{
            //             strapi.webSocket.broadcast({
            //                 type: 'order',
            //                 data: null,
            //                 message: `Buy order for index ${index} with contract ${preferredContract.tsym} failed due to some error fetching order status from Flattrade`,
            //                 status: false,
            //             });
            //             let awaitingOrderConfirmation = false;  
            //             console.log('Error fetching order status from Flattrade. Setting awaitingOrderConfirmation to false');              
            //             strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
            //             strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
            //             retry++;
            //             break;
            //             // return {
            //             //     status: false,
            //             //     message: 'Error fetching order status from Flattrade'
            //             // }
            //         }
            //     }else {
            //         strapi.webSocket.broadcast({
            //             type: 'order',
            //             data: null,
            //             message: `Buy order for index ${index} with contract ${preferredContract.tsym} failed due to some error placing order with Flattrade`,
            //             status: false,
            //         });
            //         let awaitingOrderConfirmation = false;
            //         console.log('Error placing order with Flattrade. Setting awaitingOrderConfirmation to false');                
            //         strapi[`${indexToken}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
            //         strapi.db.query('api::variable.variable').update({ where: { indexToken }, data: { awaitingOrderConfirmation } });
            //         retry++;
            //         break;
            //         // return {
            //         //     status: false,
            //         //     message: 'Error placing order with Flattrade'
            //         // }
            //     }
            // console.log("Placing bracket order for:", chosenContract.token);
            // await strapi
            //   .service("api::order.order")
            //   .placeBracketOrder(chosenContract.token, target, stopLoss);
    
        //     return ctx.send("success");
        //   } else {
        //     // No contract gained 0.9, or time window ended
        //     return ctx.send({
        //       message: "No contract breached +0.9 or time ended. Stopping operation.",
        //       status: false,
        //     });
        //   }
        } catch (error) {
          console.error("Error in startAmountBasedTrading:", error);
          return ctx.badRequest("Trading failed due to an internal error.");
        }
      },
    
}));

