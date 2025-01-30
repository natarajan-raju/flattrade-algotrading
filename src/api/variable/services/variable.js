'use strict';

const { env } = require('@strapi/utils');






/**
 * variable service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;



module.exports = createCoreService('api::variable.variable', ({ strapi }) => ({

  //Convert date to string for Scrip search
  async convertDateFormat(inputDate) {    
    const dateParts = inputDate.split('-'); // Split YYYY-MM-DD into [YYY,MM,DD]
    const [year, month, day] = dateParts;    
    const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const monthIndex = parseInt(month, 10) - 1; // Convert month from 1-based to 0-based index    
    const formattedDate = `${day}${monthNames[monthIndex]}${year.toString().slice(-2)}C`;
    return formattedDate;    
  },

  //Generate Scrip list and process Option chain
  async processScripList(indexToken,index,sampleContractTsym, sessionToken){   

    //Fetch the relevant option chain and store for future use
    try {      
      //Check if a contract for the given token exist in database already or create it
      let contract = await strapi.db.query('api::contract.contract').findOne({where: {index}});
      if(!contract){
        contract =await strapi.db.query('api::contract.contract').create({
          data:{
            sampleContractTsym,
            index,
            indexToken                            
          },
        });
      }
      
      const match = sampleContractTsym.match(/([CP])(\d+)$/);

      // Prepare the payload for the option chain request
      const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","tsym":"${sampleContractTsym}","exch":"NFO","strprc":"${parseInt(match[2],10)}","cnt":"400"}&jKey=${sessionToken}`;
      const optionChainResponse = await fetch(`${env('FLATTRADE_OPTION_CHAIN_URL')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: payload,
      });
    
      // Parse the response JSON
      const optionChain = await optionChainResponse.json();
      
      if(!optionChain.values){
        throw new Error('Option chain processing failed...');
      }

      const contractTokens = {
        ce: [],
        pe: [],        
      };

      

      let scripList = `NSE|${indexToken}`;

      // Iterate over the option chain values to populate call and put objects
      optionChain.values.forEach(option => {
        const tokenData = { token: option.token, optt: option.optt, tsym: option.tsym, ls: option.ls, index, lp: 0 }; // Initialize lp as 0
        scripList += `#NFO|${option.token}`;
        if(option.optt === 'CE'){
          contractTokens.ce.push(tokenData);
        }else if(option.optt === 'PE'){
          contractTokens.pe.push(tokenData);
        }
        strapi[`${option.token}`] = new Map();
        strapi[`${option.token}`].set('optt', option.optt);
        strapi[`${option.token}`].set('tsym', option.tsym);
        strapi[`${option.token}`].set('ls', option.ls);
        strapi[`${option.token}`].set('index', index);
        // contractTokens[`${option.token}`] = tokenData;
        
      });

      strapi[`${index}`].set('contractTokens', contractTokens);
      
      // Update the contract in the database with contractTokens including token and lp
      contract = await strapi.db.query('api::contract.contract').update({
        where: { sampleContractTsym },
        data: {
          contractTokens,
        },
      });

     

      //Update the scrip list in database
      await strapi.db.query('api::web-socket.web-socket').update({
        where: { indexToken } ,
        data: { scripList },
      });
      return scripList;
    } catch (error) {
      throw new Error(error);
    }  
                                
  },

  //Custom service function to handle trade logic basis Flattrade touchline feed
  async handleFeed(feedData) {

    const { lp, tk } = feedData;
    if(!lp){
      return { message: 'Not a LTP message' };
    } 
    // Tokens for buy/sell operations
    const buySellTokens = new Set(['26000', '26009', '26013', '26014', '26037']);
    if (!buySellTokens.has(tk)) {     
      //NFO Price update received. Update lp for contract token
      if(strapi[`${tk}`]){
          const { optt, index } = Object.fromEntries(strapi[`${tk}`]);
          if(strapi[`${index}`]){
            const contractTokens = strapi[`${index}`].get('contractTokens');
            //update the lp for current tk in contractTokens
            if(optt === 'CE'){
              contractTokens.ce.find(item => item.token === tk).lp = lp;
            } else if(optt === 'PE'){
              contractTokens.pe.find(item => item.token === tk).lp = lp;
            }
            strapi[`${index}`].set('contractTokens', contractTokens);
            const contractBought = strapi[`${index}`].get('contractBought') || null;
            try{
              if(contractBought && contractBought.contractToken === tk){
                const currentValue = parseFloat(lp) * parseFloat(contractBought.quantity);
                const costPrice = parseFloat(contractBought.costPrice);
                const realizedPL = currentValue - costPrice;
                const profitThreshold = parseFloat(contractBought.costPrice) * 1.30;
                const stopLossThreshold = parseFloat(contractBought.costPrice) * 0.90;
                strapi[`${index}`].set('currentValue', currentValue);
                strapi[`${index}`].set('stopLossThreshold', stopLossThreshold);
                strapi[`${index}`].set('profitThreshold', profitThreshold);
                const contractUpdate = {
                  index,
                  contract: contractBought.tsym,
                  quantity: contractBought.quantity,
                  costPrice,
                  currentValue,
                  realizedPL,
                  stopLossThreshold
                };                           
                //send a Strapi web broadcast to client regarding the contract bought's token lp
                strapi.log.info(`${index} contract Cost Price: ${contractBought.costPrice} Current Value: ${parseFloat(lp) * parseFloat(contractBought.quantity)} Realized PL: ${realizedPL} Stop Loss sales will be triggered on or below ${stopLossThreshold}`);
                console.table(contractUpdate);
                strapi.webSocket.broadcast({
                  type: 'position',
                  data: {
                    tk,
                    token: tk,
                    lp,
                    realizedPL
                  },
                  status: true
                });
              }
            }catch(error){
              console.log(error);
            }
            
        }
        return { message: 'NFO Price updation received' }; 
      }           
    } else {
      try {
        // Parse the lookback period once
        const lookbackPeriod = parseInt(env('SIDEWAYS_THRESHOLD_LOOKBACKPERIOD', 14), 10);       
        // Sideways market detection strategy
        if (!strapi.rollingData[`${tk}`]) {
          strapi.rollingData[`${tk}`] = {
            prices_lookback_period: [],
            isSidewaysMarket: false,
            atrValues: []                      
          };
        }
      
        strapi.rollingData[`${tk}`].prices_lookback_period.push({ lp });        
        const index = strapi[`${tk}`].get('index') || tk;
        // Keep only the required number of points
        if (strapi.rollingData[`${tk}`].prices_lookback_period.length > lookbackPeriod) {
          strapi.rollingData[`${tk}`].prices_lookback_period.shift();
        }       
      
        // Ensure sufficient data for sideways market calculation
        if (strapi.rollingData[`${tk}`].prices_lookback_period.length >= lookbackPeriod) {
          // Calculate metrics for Sideways market detection
          const isSidewaysMarket = await this.calculateSidewaysMarket(tk, strapi.rollingData[`${tk}`].prices_lookback_period);
          console.log(`Sideways market detection for ${tk}: ${isSidewaysMarket}`);
          // Handle Websocket broadcast for sideways market detection
          if (isSidewaysMarket && !strapi.rollingData[`${tk}`].isSidewaysMarket) {
            // Send a Strapi web broadcast to client regarding sideways market detection
            strapi.log.info(`Index ${tk} entering a sideways market...`);
            strapi.webSocket.broadcast({
              type: 'market',
              message: `Index ${index} entering a sideways market.Trading not advised.. Pause for Stop loss...`,
              isSideWays: true,
              status: '001',
              tk
            });
            strapi.rollingData[`${tk}`].isSidewaysMarket = true;
          } else if (!isSidewaysMarket && strapi.rollingData[`${tk}`].isSidewaysMarket) {
            // Broadcast sideways market end
            strapi.log.info(`Index ${index} exiting a sideways market...`);
            strapi.webSocket.broadcast({
              type: 'market',
              message: `Market is trending now for Index ${index}`,
              status: '002',              
              isSideWays: false,
              tk
            });
            strapi.rollingData[`${tk}`].isSidewaysMarket = false;
          }
        } else {
          strapi.webSocket.broadcast({
            type: 'market',
            message: `Application trying to deduct market status for Index token ${index}...`,
            isSideWays: false,
            status: '003',
            tk
          });
        }
      } catch (error) {
        console.log(`Error calculating sideways market for ${tk}: ${error}`);
      }
      

        strapi.webSocket.broadcast({
          type: 'index',
          data: feedData,          
          status: true
        })
        console.log(feedData);
        
          const headers = {
              Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Including the special token in the Authorization header
          };  
          //Try to fetch indexItem from local Map
          let indexItem;
          if(strapi[`${tk}`]){
            indexItem = Object.fromEntries(strapi[`${tk}`]);
          } else {
            strapi.log.info('Fetching from database.. Please check map allocation');
            indexItem = await strapi.db.query('api::variable.variable').findOne({
              where: { indexToken: tk },
            });
          }
          if(!indexItem){
            return { message: `No index found for token ${tk}`};
          }

          // Extract variables of the index
            let {
              basePrice, resistance1, resistance2, support1, support2, targetStep, lossStep,
              callOptionBought, putOptionBought,callBoughtAt, putBoughtAt, indexToken, index,initialSpectatorMode,previousTradedPrice, amount, quantity, awaitingOrderConfirmation
            } = indexItem;
            
            
            if (basePrice === 0 || resistance1 === 0 || resistance2 === 0 || support1 === 0 || support2 === 0){        
              return { message: `Investment variables not defined for ${index}`};
            } 

            if(previousTradedPrice === 0){
              console.log(`First feed after submitting variables: Setting ${lp} as Last Traded Price for ${tk}`);
              strapi[`${tk}`].set('previousTradedPrice', lp);
              return { message: 'First feed' };
            }
            
            if(awaitingOrderConfirmation){            
              strapi.webSocket.broadcast({
                type: 'variable',
                message: `Order placement awaiting confirmation for index ${index}. No actions taken at LTP ${lp}`,
                status: true,
              });
              console.log(`Order placement awaiting confirmation for index ${index}. No actions taken at LTP ${lp}`);
              strapi[`${tk}`].set('previousTradedPrice', lp);
              return { message: 'Awaiting order confirmation' };
            }
          
            
          
            //Check if initialSpectatorMode is active
            if(initialSpectatorMode){
              if((lp <= parseFloat(basePrice) + parseFloat(targetStep) && lp >= basePrice - targetStep)
                || (lp <= parseFloat(resistance1) + parseFloat(targetStep) && lp >= resistance1 - targetStep)
                || (lp <= parseFloat(resistance2) + parseFloat(targetStep) && lp >= resistance2 - targetStep)
                || (lp <= parseFloat(support1) + parseFloat(targetStep) && lp >= support1 - targetStep)
                || (lp <= parseFloat(support2) + parseFloat(targetStep) && lp >= support2 - targetStep)
              ){
                //LP in investment hot zone. Turn off Spectator mode
                initialSpectatorMode = false;
                strapi[`${tk}`].set('initialSpectatorMode', initialSpectatorMode);
                strapi.db.query('api::variable.variable').update({
                  where: {indexToken: `${tk}`},
                  data: {initialSpectatorMode},
                });
                strapi.webSocket.broadcast({ type: 'variable', message: `Reaching strategic position.Spectator mode turned off for index ${index}`, status: true});
                strapi.log.info('Reaching strategic position.Spectator mode turned off');
              } else {
                //LP in Passive zone. Do not take any action
                previousTradedPrice = lp;
                strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);  
                console.log(`No actions taken for index ${index} at LTP ${lp}. LP in passive zone, InitialSpectatorMode: ${initialSpectatorMode}`);        
                strapi.webSocket.broadcast({ type: 'variable', message: `No actions taken for index ${index} at LTP ${lp}`, status: true});
                return `No actions taken at LTP ${lp}`;
              }
            }            
            
            if(strapi.isTradingEnabled){
              let contractType;           
              //Buy CALL
              if(!callOptionBought && !putOptionBought && !initialSpectatorMode && !strapi.rollingData[`${tk}`].isSidewaysMarket){                
                if(((lp >= parseFloat(basePrice) + parseFloat(targetStep) && lp < resistance1 - targetStep) 
                  || (lp >= parseFloat(resistance1) + parseFloat(targetStep) && lp < resistance2 - targetStep)
                  || (lp>= parseFloat(resistance2) + parseFloat(targetStep))
                  || (lp >= parseFloat(support1) + parseFloat(targetStep) && lp < basePrice - targetStep)
                  || (lp >= parseFloat(support2) + parseFloat(targetStep) && lp < support1 - targetStep))
                  && ( previousTradedPrice < lp)
                ){                 
                  //Buy CALL
                  callOptionBought = true;
                  callBoughtAt = lp;
                  previousTradedPrice = lp;
                  awaitingOrderConfirmation = true;                  
                  strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                  // strapi.db.query('api::variable.variable').update({
                  //   where: {indexToken : `${tk}`},
                  //   data: {
                  //     awaitingOrderConfirmation,
                  //   }
                  // });
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy CALL at LTP ${lp}`, status: true});
                  console.log(`Reached Strategic Buy zone for ${index}. Application will attempt to buy CALL at LTP ${lp}`);
                  contractType = 'CE';              
                  const orderStatus = await strapi.service('api::order.order').placeBuyOrder({contractType,lp,quantity,index,indexToken,amount});              
                  if(orderStatus.status === true || orderStatus.status === 'true'){
                    console.log('CALL buy Order status true from variable service. Resetting awaitingOrderConfirmation to false');
                    strapi[`${tk}`].set('callOptionBought', callOptionBought);
                    strapi[`${tk}`].set('callBoughtAt', callBoughtAt);
                    strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
                    strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                    strapi.db.query('api::variable.variable').update({
                      where: {indexToken : `${tk}`},
                      data: {
                        callOptionBought,
                        callBoughtAt,
                        previousTradedPrice,
                        awaitingOrderConfirmation: false,
                      }
                    });
                    return {
                      status: true,
                      message: 'CALL buy Order placed successfully',
                      
                    } 
                  }else{
                    console.log('CALL buy Order status false from variable service. Resetting awaitingOrderConfirmation to false');
                    strapi[`${tk}`].set('callOptionBought', false);
                    strapi[`${tk}`].set('callBoughtAt', 0);
                    strapi[`${tk}`].set('previousTradedPrice', lp);
                    strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                    strapi.db.query('api::variable.variable').update({
                      where: {indexToken : `${tk}`},
                      data: {
                        callOptionBought: false,
                        callBoughtAt: 0,
                        previousTradedPrice,
                        awaitingOrderConfirmation: false,
                      }
                    });
                    return {
                      status: false,
                      message: 'CALL buy Order failed',
                      
                    } 
                  }                  
                  
                                     
                } else if(((lp <= basePrice - targetStep && lp > parseFloat(support1) + parseFloat(targetStep)) 
                  || (lp <= support1 - targetStep && lp > parseFloat(support2) + parseFloat(targetStep))
                  || (lp <= support2 - targetStep)
                  || (lp <= resistance1 - targetStep && lp > parseFloat(basePrice) + parseFloat(targetStep))
                  || (lp <= resistance2 - targetStep && lp > parseFloat(resistance1) + parseFloat(targetStep)))
                  && (previousTradedPrice > lp)
                ){             
                  //Buy PUT 
                  
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy PUT at LTP ${lp}`, status: true});
                  console.log(`Reached Strategic Buy zone for ${index}. Application will attempt to buy PUT at LTP ${lp}`);
                  contractType = 'PE';
                  putOptionBought = true;
                  putBoughtAt = lp;
                  previousTradedPrice = lp;
                  awaitingOrderConfirmation = true;
                  strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                  const orderStatus = await strapi.service('api::order.order').placeBuyOrder({contractType,lp,quantity,index,indexToken, amount});
                  if(orderStatus.status === true || orderStatus.status === 'true'){
                    console.log('PUT buy Order status true from variable service. Resetting awaitingOrderConfirmation to false');
                    strapi[`${tk}`].set('putOptionBought', putOptionBought);
                    strapi[`${tk}`].set('putBoughtAt', putBoughtAt);
                    strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
                    strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                    strapi.db.query('api::variable.variable').update({
                      where: {indexToken : `${tk}`},
                      data: {              
                        putOptionBought,
                        putBoughtAt,
                        previousTradedPrice,
                        awaitingOrderConfirmation
                      }
                    });
                    return {
                      status: true,
                      message: 'PUT buy Order placed successfully',                            
                    }                    
                  } else {
                    console.log('PUT buy Order status false from variable service. Resetting awaitingOrderConfirmation to false');
                    strapi[`${tk}`].set('putOptionBought', false);
                    strapi[`${tk}`].set('putBoughtAt', 0);
                    strapi[`${tk}`].set('previousTradedPrice', lp);
                    strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                    strapi.db.query('api::variable.variable').update({
                      where: {indexToken : `${tk}`},
                      data: {
                        putOptionBought: false,
                        putBoughtAt: 0,
                        previousTradedPrice,
                        awaitingOrderConfirmation: false,
                      }
                    });
                    return {
                      status: false,
                      message: 'PUT buy Order failed',
                    }
                  }                    
                }
              }
              
              //Sell CALL
              if(callOptionBought){
                let stopLossTriggered;
                if(strapi[`${index}`].get('currentValue') <= strapi[`${index}`].get('stopLossThreshold')){
                  stopLossTriggered = true;
                } else {
                  stopLossTriggered = false;
                }

                let takeProfitTriggered;
                if(strapi[`${index}`].get('currentValue') >= strapi[`${index}`].get('profitThreshold')){
                  takeProfitTriggered = true;
                } else {
                  takeProfitTriggered = false;
                }
                if(
                  takeProfitTriggered
                  ||stopLossTriggered
                  || ((lp >= basePrice && (callBoughtAt >= parseFloat(support1) + parseFloat(targetStep) && callBoughtAt < basePrice)) || ((lp <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (callBoughtAt >= parseFloat(basePrice) + parseFloat(targetStep) && callBoughtAt < resistance1))) //Previously lp<= basePrice at stop loss initial check
                  || ((lp >= resistance1 && (callBoughtAt >= parseFloat(basePrice) + parseFloat(targetStep) && callBoughtAt < resistance1)) || ((lp <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (callBoughtAt >= parseFloat(resistance1) + parseFloat(targetStep) && callBoughtAt < resistance2))) //Previously lp<= resistance1 at stop loss initial check
                  || ((lp >= support1 && (callBoughtAt >= parseFloat(support2) + parseFloat(targetStep) && callBoughtAt < support1)) || ((lp <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (callBoughtAt >= parseFloat(support1) + parseFloat(targetStep) && callBoughtAt < basePrice))) //Previously lp<= support1 at stop loss initial check
                  || ((lp >=resistance2 && (callBoughtAt >= parseFloat(resistance1) + parseFloat(targetStep) && callBoughtAt < resistance2)) || ((lp <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && callBoughtAt  >= parseFloat(resistance2) + parseFloat(targetStep))) //Previously lp<= resistance2 at stop loss initial check
                  || ((lp >= support2 && callBoughtAt < support2) || ((lp <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (callBoughtAt >= parseFloat(support2) + parseFloat(targetStep) && callBoughtAt < support1))) //Previously lp<= support2 at stop loss initial check
                ){              
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Sell zone for ${index}. Application will attempt to sell CALL at LTP ${lp}`, status: true});     
                  console.log(`Reached Strategic Sell zone for ${index}. Application will attempt to sell CALL at LTP ${lp}`);
                  //call sell API
                  
                    contractType = 'CE';              
                    callOptionBought = false; 
                    callBoughtAt = 0;             
                    previousTradedPrice = lp;
                    awaitingOrderConfirmation = true;
                    strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                    const orderStatus = await strapi.service('api::order.order').placeSellOrder({contractType,lp,index,indexToken,quantity});
                    if(orderStatus.status === true || orderStatus.status === 'true'){
                      strapi[`${index}`].set('stopLossThreshold', 0);   
                      strapi[`${index}`].set('profitThreshold', Infinity);                   
                      console.log('CALL sell Order status true from variable service. Resetting awaitingOrderConfirmation to false');
                      strapi[`${tk}`].set('callOptionBought', callOptionBought);
                      strapi[`${tk}`].set('callBoughtAt', callBoughtAt);
                      strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
                      strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                      strapi.db.query('api::variable.variable').update({
                        where: {indexToken : `${tk}`},
                        data: {
                          callOptionBought,                  
                          previousTradedPrice,
                          callBoughtAt,
                          awaitingOrderConfirmation: false,
                        }
                      });
                      return {
                        status: true,
                        message: 'CALL sell Order placed successfully',
                      }
                    } else {
                      console.log('CALL sell Order status false from variable service. Resetting awaitingOrderConfirmation to false');
                      strapi[`${tk}`].set('awaitingOrderConfirmation', false);                      
                      strapi.db.query('api::variable.variable').update({
                        where: {indexToken : `${tk}`},
                        data: {
                          awaitingOrderConfirmation: false,
                        }
                      });
                      return {
                        status: false,
                        message: 'CALL sell Order placement failed',
                      }
                    }   
                    
                                                                  
                }
              }
          
              //Sell PUT
              if(putOptionBought){
                let stopLossTriggered;
                if(strapi[`${index}`].get('currentValue') <= strapi[`${index}`].get('stopLossThreshold')){
                  stopLossTriggered = true;
                } else {
                  stopLossTriggered = false;
                }

                let takeProfitTriggered;
                if(strapi[`${index}`].get('currentValue') >= strapi[`${index}`].get('profitThreshold')){
                  takeProfitTriggered = true;
                } else {
                  takeProfitTriggered = false;
                }
                if(
                  takeProfitTriggered
                  || stopLossTriggered
                  || ((lp <= basePrice && (putBoughtAt <= resistance1 - targetStep && putBoughtAt > basePrice)) || ((lp >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (putBoughtAt <= basePrice - targetStep && putBoughtAt > support1)))
                  || ((lp <= support1 && (putBoughtAt <= basePrice - targetStep && putBoughtAt > support1)) || ((lp >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (putBoughtAt <= support1 - targetStep && putBoughtAt > support2)))
                  || ((lp <= resistance1 && (putBoughtAt <= resistance2 - targetStep && putBoughtAt > resistance1)) || ((lp >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (putBoughtAt <= resistance1 - targetStep && putBoughtAt > basePrice)))
                  || ((lp <= support2 && (putBoughtAt <= support1 - targetStep && putBoughtAt > support2)) || ((lp >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && putBoughtAt <= support2 - targetStep))
                  || ((lp <= resistance2 && putBoughtAt > resistance2) || ((lp >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (putBoughtAt <= resistance2 - targetStep && putBoughtAt > resistance1))) //Stop loss at Resistance 2
                ){                            
                  
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Sell zone for ${index}. Application will attempt to sell PUT at LTP ${lp}`, status: true}); 
                  console.log(`Reached Strategic Sell zone for ${index}. Application will attempt to sell PUT at LTP ${lp}`);
                  //PUT sell API 
                
                    contractType = 'PE';             
                    putOptionBought = false;  
                    putBoughtAt = 0;            
                    previousTradedPrice = lp;
                    awaitingOrderConfirmation = true;
                    strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                    let orderStatus = await strapi.service('api::order.order').placeSellOrder({contractType,lp,index,indexToken,quantity});
                    if(orderStatus.status === true || orderStatus.status === 'true'){
                      strapi[`${index}`].set('stopLossThreshold', 0);
                      strapi[`${index}`].set('profitThreshold', Infinity);
                      console.log('PUT sell Order status true from variable service. Resetting awaitingOrderConfirmation to false');
                      strapi[`${tk}`].set('putOptionBought', putOptionBought);
                      strapi[`${tk}`].set('putBoughtAt', putBoughtAt);
                      strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
                      strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                      let updatedVariable = await strapi.db.query('api::variable.variable').update({
                        where: {indexToken: `${tk}`},
                        data: {
                          putOptionBought,                  
                          previousTradedPrice,
                          putBoughtAt,
                          awaitingOrderConfirmation
                        }           
                      });
                      
                      return {
                        status: true,
                        message: 'PUT sell Order placed successfully',
                        updatedVariable,
                      } 
                    } else {
                      console.log('PUT sell Order status false from variable service. Resetting awaitingOrderConfirmation to false');
                      strapi[`${tk}`].set('awaitingOrderConfirmation', false);
                      let updatedVariable = await strapi.db.query('api::variable.variable').update({
                        where: {indexToken: `${tk}`},
                        data: {
                          awaitingOrderConfirmation: false,
                        }
                      });
                      return {
                        status: false,
                        message: 'PUT sell Order placement failed',
                        updatedVariable,
                      }
                    }
                                             
                }
              }
            }else{
              strapi.log.info('Trading will be execercised only between 09:15 and 15:30 hrs. Please wait...');
              strapi.webSocket.broadcast({ type: 'variable', message: `Trading will initiate only after 09:30 hrs`, status: true});
            }  
            strapi[`${tk}`].set('previousTradedPrice', lp);     
        
    }   
  },
  // Custom function to reset investment variables
  async resetInvestmentVariables() {
    try {
      strapi.rollingData = {};
      const defaultValues = {
        basePrice: 0,
        resistance1: 0,
        resistance2: 0,
        support1: 0,
        support2: 0,
        amount: 0,
        previousTradedPrice: 0,
        initialSpectatorMode: true,
        callOptionBought: false,
        putOptionBought: false,
        callBoughtAt: 0,
        putBoughtAt: 0,
        quantity: 0, 
        awaitingOrderConfirmation: false       
      };

      const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`,
      };

      // Fetch all entries in the variable collection
      const variableEntries = await strapi.db.query('api::variable.variable').findMany({
        headers,
      });

      // Iterate over each entry and update it with default values
      for (const entry of variableEntries) {
        await strapi.db.query('api::variable.variable').update({
          where: { id: entry.id },
          data: defaultValues,
        });
      }

      //Update all positions
      await strapi.db.query('api::position.position').updateMany({
        data: {
          contractType: '',
          contractToken: '',
          tsym: '',
          lotSize: '',
          quantity: 0,
          price: 0,
        }
      })  
      

      strapi.webSocket.broadcast({ type: 'action',message: "Investment variables & Positions reset", status: true, });
      strapi.log.info('Investment variables & Positions reset');
         
    } catch (error) {
      strapi.webSocket.broadcast({ type: 'action',message: "Error resetting investment variables. Please reset all variables", status: false, });
        
    }
    
  },

  //Sideways market detection logic
  async calculateSidewaysMarket(tk, data) {
    const lookbackPeriod = parseInt(env('SIDEWAYS_THRESHOLD_LOOKBACKPERIOD', 14), 10);
    const percentageThreshold = parseFloat((parseFloat(env('SIDEWAYS_THRESHOLD_PERCENTAGE_CHANGE', 2)) / 100).toFixed(4));
    const bbwThreshold = parseFloat((parseFloat(env('SIDEWAYS_THRESHOLD_BBW', 2)) / 100).toFixed(4));
    // ATR percentage threshold (e.g., 0.5% of the index value)
    const atrPercentageThreshold = parseFloat(env('SIDEWAYS_THRESHOLD_ATR', 0.1)) / 100;
    // console.log(atrPercentageThreshold);
    // Extract last traded prices
    const prices = data.map(entry => parseFloat(entry.lp));
   
    // Dynamically calculate high and low for the current sample
    const currentHigh = Math.max(...prices);
    const currentLow = Math.min(...prices);
  
    // Calculate percentage change
    const percentageChange = parseFloat((((currentHigh - currentLow) / currentLow) * 100).toFixed(4));
  
    // ATR Calculation
    const trueRanges = [];
    data.forEach((entry, index) => {
      if (index === 0) return; // Skip the first entry (no previous data to compare)
  
      // const currentHigh = parseFloat(entry.hp);
      // const currentLow = parseFloat(entry.lp);
      const previousClose = parseFloat(data[index - 1].lp);
  
      // Calculate true range
      const highLowRange = currentHigh - currentLow;
      const highCloseRange = Math.abs(currentHigh - previousClose);
      const lowCloseRange = Math.abs(currentLow - previousClose);  
      trueRanges.push(Math.max(highLowRange, highCloseRange, lowCloseRange));
    });
  
    // Calculate ATR as the average of true ranges over the lookback period
    const atr = parseFloat((trueRanges.slice(-lookbackPeriod).reduce((sum, tr) => sum + tr, 0) / lookbackPeriod).toFixed(4));
    // Dynamically calculate ATR threshold as a percentage of the current index price (average of prices)
    const currentIndexValue = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const atrThreshold = parseFloat((currentIndexValue * atrPercentageThreshold).toFixed(4));

    //ATR MA calculation
    strapi.rollingData[`${tk}`].atrValues.push(atr);
    if (strapi.rollingData[`${tk}`].atrValues.length > 20) {
      strapi.rollingData[`${tk}`].atrValues.shift();
    }
    
    // Bollinger Band Width (BBW) Calculation
    const sma = prices.slice(-lookbackPeriod).reduce((sum, price) => sum + price, 0) / lookbackPeriod;
    
    const squaredDiffs = prices
    .slice(-lookbackPeriod)
    .map(price => Math.pow(price - sma, 2));
    const variance = squaredDiffs.reduce((sum, squaredDiff) => sum + squaredDiff, 0) / lookbackPeriod;
    const stdDev = Math.sqrt(variance);
    
    const upperBand = sma + 2 * stdDev;
    const lowerBand = sma - 2 * stdDev;
    const bbw = parseFloat((((upperBand - lowerBand) / sma) * 100).toFixed(4));
    
    if(strapi.rollingData[`${tk}`].atrValues.length === 20){ 
      const atrMA = strapi.rollingData[`${tk}`].atrValues.reduce((sum, value) => sum + value, 0) / strapi.rollingData[`${tk}`].atrValues.length;
      console.log(`Index: ${tk}, ATR: ${atr}, ATR Threshold: ${atrThreshold}, ATR MA: ${atrMA}, BBW: ${bbw}, BBW Threshold: ${bbwThreshold}, Percentage Change: ${percentageChange}, PC Threshold: ${percentageThreshold}`);
      // Check if sideways market conditions are met
      return (
        Math.abs(percentageChange) <= percentageThreshold &&
        atr <= atrThreshold &&
        atr <= atrMA &&
        bbw <= bbwThreshold
      );
    } else {
      console.log(`Index: ${tk}, ATR: ${atr}, ATR Threshold: ${atrThreshold}, BBW: ${bbw}, BBW Threshold: ${bbwThreshold}, Percentage Change: ${percentageChange}, PC Threshold: ${percentageThreshold}`);
      return (
        Math.abs(percentageChange) <= percentageThreshold &&
        atr <= atrThreshold &&
        bbw <= bbwThreshold
      );
    } 
  },



  //Cron function to stop market at 3.15pm daily
  async stopTrading(indexToken) {
    if(!indexToken){
        return {status: false, message: 'No token passed to stopTrading'};
    }
   
    
    
    const defaultValues = {
      basePrice: 0,
      resistance1: 0,
      resistance2: 0,
      support1: 0,
      support2: 0,
      amount: 0,
      quantity: 0,
      previousTradedPrice: 0, 
      initialSpectatorMode: true,
      callOptionBought: false,
      putOptionBought: false,
      callBoughtAt: 0,
      putBoughtAt: 0,
      awaitingOrderConfirmation: false                               
    };
    const headers = {
      Authorization: `Bearer ${env('SPECIAL_TOKEN')}`,
    };
    if(indexToken === '1'){
        const contractEntries = await strapi.db.query('api::contract.contract').findMany();
        if(contractEntries.length > 0){
          for (const contract of contractEntries) {
            Object.keys(contract.contractTokens).forEach((token) => {
              delete strapi[`${token}`];
            });
          }
        }
        // Fetch all variable entries
        const variableEntries = await strapi.db.query('api::variable.variable').findMany({
          select: ['id'], // Select only the 'id' field
        });

        // Iterate over each entry and update it with default values
        for (const entry of variableEntries) {
          await strapi.db.query('api::variable.variable').update({
            where: { id: entry.id },
            data: defaultValues,
          });
          delete strapi[`${entry.index}`];
          delete strapi[`${entry.indexToken}`];
          strapi.rollingData[`${entry.indexToken}`] = {};
        } 
        //Reset scrip list in database and cache
        const scrips = await strapi.db.query('api::web-socket.web-socket').findMany(
          { where: 
            { scripList: {
                $ne: '',
                $notNull: true,
              } 
            }
          }
        );

        
        strapi.webSocket.broadcast({type: 'action', message: 'Application is stopped now.Please sell all positions before starting to trade again.', status: true});
        return {status: true, message: 'Application stopped now..'};      
    }else{
      strapi.rollingData[`${indexToken}`] = {};
      try{
        const scrip = await strapi.db.query('api::web-socket.web-socket').findOne({where: { indexToken }});
        if(scrip.scripList){
          try{
            strapi.service('api::web-socket.web-socket').unsubscribeTouchline(scrip.scripList);
            strapi[`${indexToken}`].set('scripList', '');
          }catch(error){
            console.log(error);
          };                   
          strapi.db.query('api::web-socket.web-socket').update({where: { indexToken }, data: { scripList: '' }});          
        } 
      }catch(e){
        console.log(e);
      }
      // const variable = await strapi.db.query('api::variable.variable').findOne({
      //   where: { indexToken },
      // });
      // if(variable){
        // if(variable.callOptionBought){
        //   strapi.webSocket.broadcast({type: 'variable',message: 'Please sell all positions before starting to trade again.', status: true});        
        // }else{
        //   defaultValues.initialSpectatorMode = true;
        // }      
          const variable = await strapi.db.query('api::variable.variable').update({
            where: { indexToken }, // Specify the condition for the update
            data: defaultValues,        // Specify the new data
          });
          strapi[`${indexToken}`] = new Map(Object.entries(variable));
          console.log(`Application is stopping. For sample basePrice in ${indexToken} is ${strapi[`${indexToken}`].get('basePrice')}`);


          //Check if any position is available in DB and clear it
          strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType: '', contractToken: '',tsym: '',lotSize: '', quantity: 0, price: 0 } });
          const contractBought = {};
          strapi[`${variable.index}`].set('contractBought', contractBought);
          // delete strapi[`${indexToken}`];
          // delete strapi[`${variable.index}`];
          strapi.webSocket.broadcast({type: 'order', message: `Application is stopped now for index ${variable.index}.Please sell all positions before starting to trade again.`, status: true});
          return {status: true, message: `Application stopped now for index ${variable.index}...`};        
      // }
    }
  },



  async fetchIndexVariables(){
    await strapi.service('api::authentication.authentication').fetchRequestToken();
    const contracts = await strapi.db.query('api::contract.contract').findMany({
      where: {
        //sampleContractTsym length is not equal to zero
        sampleContractTsym: { 
          $ne: '',
          $notNull: true,
        },
      },
    });

    if(contracts.length > 0){
      for (const contract of contracts) {
        strapi[`${contract.index}`] = new Map();

        strapi[`${contract.index}`].set('contractTokens', contract.contractTokens || {});
        
        
        const contractTokens = contract.contractTokens;
        contractTokens.ce.forEach(contract => {
          const {token, optt, tsym, ls, index} = contract;
          strapi[`${token}`] = new Map();
          strapi[`${token}`].set('optt', optt);
          strapi[`${token}`].set('tsym', tsym);
          strapi[`${token}`].set('ls', ls);
          strapi[`${token}`].set('index', index);
        });
        contractTokens.pe.forEach(contract => {
          const {token, optt, tsym, ls, index} = contract;
          strapi[`${token}`] = new Map();
          strapi[`${token}`].set('optt', optt);
          strapi[`${token}`].set('tsym', tsym);
          strapi[`${token}`].set('ls', ls);
          strapi[`${token}`].set('index', index);
        });
        
             
      }
    }
    strapi.log.info('Contracts fetched...');
    const positions = await strapi.db.query('api::position.position').findMany({
      where: {
        contractToken: {
          $ne: '',
          $notNull: true,
        }
      }
    });

    if(positions.length > 0){
      for (const position of positions) {
        const contractBought = {
          contractType: position.contractType,
          contractToken: position.contractToken,
          tsym: position.tsym,
          quantity: position.quantity || 0,
          costPrice: position.price || 0,
          
        }
        strapi[`${position.index}`].set('contractBought', contractBought);
      }
    }
    strapi.log.info('Positions fetched...');
    const variables = await strapi.db.query('api::variable.variable').findMany({
      where: {
        basePrice: { $gt: 0 },  // '$gt' means greater than
      },
    });
    if(variables.length > 0){
      for (const indexItem of variables) {
        
        strapi[`${indexItem.indexToken}`] = new Map(Object.entries(indexItem));        
        const scrip = await strapi.db.query('api::web-socket.web-socket').findOne({where: { indexToken: indexItem.indexToken }});
              
        strapi[`${indexItem.indexToken}`].set('scripList', scrip.scripList);
        // if(strapi[`${indexItem.index}`]){
        //   strapi[`${indexItem.index}`].set('amount', indexItem.amount);
        // }
               
        
      }      
    } 
    
    strapi.log.info('Variables fetched...');  
  },

  //Fetch time price data from flattrade
  async getTimePriceData(indexToken, interval, startDate) {
    const currentDate = new Date();

    // Calculate startTime and endTime
    const startTime = new Date(startDate).getTime() / 1000;
    const endTime = Math.floor(currentDate.getTime() / 1000);

    // console.log(`StartTime: ${startTime}, EndTime: ${endTime}, Interval: ${interval}`);

    try {
        const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","exch":"NSE","token":"${indexToken}","st":"${startTime}","et":"${endTime}","intrv":"${interval}"}&jKey=${strapi.sessionToken}`;
        const timePriceResponse = await fetch(`${env('FLATTRADE_GET_TIME_PRICE_DATA_URL')}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: payload,
        });

        const timePrice = await timePriceResponse.json();

        // console.log(timePrice);
        if (!Array.isArray(timePrice) || timePrice.length === 0) {
            throw new Error(timePrice.emsg || 'Error fetching time price data');
        }

        const data = timePrice.map((item) => {
            const [day, month, yearAndTime] = item.time.split('-');
            const [year, time] = yearAndTime.split(' ');
            let parsedDate = new Date(`${year}-${month}-${day}T${time}`);

            // Adjust for IST (UTC+5:30)
            const IST_OFFSET = 5.5 * 60 * 60 * 1000; // Offset in milliseconds
            parsedDate = new Date(parsedDate.getTime() + IST_OFFSET);

            const open = parseFloat(item.into);
            const close = parseFloat(item.intc);
            const percentageChange = ((close - open) / open) * 100;

            return {
                date: parsedDate.toISOString(),
                open,
                high: parseFloat(item.inth),
                low: parseFloat(item.intl),
                close,
                pc: parseFloat(percentageChange.toFixed(2)),
            };
        });

        return {
            status: true,
            data,
            indexToken,
            interval,
            message: 'Time price data fetched successfully for the given index token and interval',
        };
    } catch (error) {
        console.log(`Error in getting time price data: ${error}`);
        return {
            status: false,
            message: `${error}`,
            data: [],
        };
    }
}

  
}));

