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
        strapi[`${option.token}`].set('rsi', 0);
        strapi[`${option.token}`].set('rsiSeries', []);
        strapi[`${option.token}`].set('prices', []);
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
          const { optt, index, prices, rsiSeries } = Object.fromEntries(strapi[`${tk}`]);
          const lookbackPeriod = 28;
          prices.push(lp);
          if(prices.length > lookbackPeriod) prices.shift();
          //Calculate RSI
          function calculateRSI(prices, period) {
            let gains = [], losses = [];
            for (let i = 1; i < prices.length; i++) {
                let change = prices[i] - prices[i - 1];
                gains.push(change > 0 ? change : 0);
                losses.push(change < 0 ? Math.abs(change) : 0);
            }

            let avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
            let avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;

            for (let i = period; i < gains.length; i++) {
                avgGain = (avgGain * (period - 1) + gains[i]) / period;
                avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
            }

            let rs = avgGain / avgLoss;
            return 100 - (100 / (1 + rs));
          }

          //Calculate EMA
          function calculateEMA(values, period) {
            if (values.length < period) return null;
            const k = 2 / (period + 1);
            return values.reduce((prev, curr, i) => 
                i === 0 ? curr : (curr * k + prev * (1 - k))
            );
          }
          
          if(prices.length <= lookbackPeriod){
             const rsi = calculateRSI(prices, prices.length) || 0;
             rsiSeries.push(rsi);
             const rsiEma = calculateEMA(rsiSeries, rsiSeries.length) || rsi;
             strapi[`${tk}`].set('rsi', rsiEma);
             strapi[`${tk}`].set('prices', prices);
             strapi[`${tk}`].set('rsiSeries', rsiSeries);
          }
          // if(prices.length > lookbackPeriod) prices.shift();
          if(strapi[`${tk}`].get('rsiSeries').length > lookbackPeriod) strapi[`${tk}`].get('rsiSeries').shift(); 
          
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
                  let awaitingOrderConfirmation = strapi[`${contractBought.indexToken}`].get('awaitingOrderConfirmation') || false;
                  if(!awaitingOrderConfirmation){                 
                    const currentValue = parseFloat(lp) * parseFloat(contractBought.quantity);
                    const costPrice = parseFloat(contractBought.costPrice);
                    const realizedPL = currentValue - costPrice;
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
                    
                    let profitThreshold = 4.10 * costPrice;            
                    let profitStage = strapi[`${index}`].get('profitStage') || 0;
                    // let roundedProfitStage = Math.floor(profitStage / 50) * 50;
                    let profitStageThreshold = Math.max(Math.floor((0.60 * profitStage) / 3.75) * 3.75, profitStage - 150);
                    if((profitStage === 0 && realizedPL >= 50) || (profitStage >=50 && realizedPL > profitStage)){
                      profitStage = Math.floor(realizedPL / 50) * 50;
                      strapi[`${index}`].set('profitStage', profitStage);
                    } else if( profitStage > 0 && realizedPL <= profitStageThreshold) {                  
                      strapi[`${index}`].set('downwardProfitTrigger', true);
                    }
                    // roundedProfitStage = Math.floor(profitStage / 50) * 50; 
                    profitStageThreshold = Math.max(Math.floor((0.60 * profitStage) / 3.75) * 3.75, profitStage - 150);                
                    const stopLossThreshold = Math.min(parseFloat(contractBought.costPrice) - (Math.floor((parseFloat(contractBought.costPrice) * 0.01875) / 37.5) * 37.5),parseFloat(contractBought.costPrice) - 37.5);
                    strapi[`${index}`].set('currentValue', currentValue);                
                    strapi[`${index}`].set('stopLossThreshold', stopLossThreshold);
                    strapi[`${index}`].set('profitThreshold', profitThreshold);
                    const contractUpdate = {
                      index,
                      indexRSI: parseFloat(parseFloat(strapi.rollingData[`${contractBought.indexToken}`].currentRSI).toFixed(4)),
                      // indexToken: contractBought.indexToken,
                      contract: contractBought.tsym,
                      contractRSI: parseFloat(parseFloat(strapi[`${tk}`].get('rsi')).toFixed(4)),
                      quantity: contractBought.quantity,
                      costPrice,
                      currentValue,
                      realizedPL,
                      profitStage,
                      profitTrigger: profitStageThreshold,
                      // profitThreshold,
                      lossTrigger: costPrice - stopLossThreshold,
                      downwardProfitTrigger: strapi[`${index}`].get('downwardProfitTrigger'),
                      // awaitingOrderConfirmation
                    };                           
                    //send a Strapi web broadcast to client regarding the contract bought's token lp
                    // strapi.log.info(`${index} contract Cost Price: ${contractBought.costPrice} Current Value: ${parseFloat(lp) * parseFloat(contractBought.quantity)} Realized PL: ${realizedPL} Stop Loss sales will be triggered on or below ${stopLossThreshold}`);
                    console.table(contractUpdate);
                    
                    // let awaitingOrderConfirmation = strapi[`${contractBought.indexToken}`].get('awaitingOrderConfirmation');
                    if(currentValue >= profitThreshold || currentValue <= stopLossThreshold || strapi[`${index}`].get('downwardProfitTrigger')){
                      strapi[`${contractBought.indexToken}`].set('awaitingOrderConfirmation', true);
                      let message;
                      if(currentValue >= profitThreshold) message = `Sell triggered as current value ${currentValue} exceeded profit threshold ${profitThreshold}`;
                      if(currentValue <= stopLossThreshold) message = `Sell triggered as current value ${currentValue} gone below stoploss threshold ${stopLossThreshold}`;
                      if(strapi[`${index}`].get('downwardProfitTrigger')) message = `Sell triggered as current value ${currentValue} gone below profit stage ${profitStage}`;
                      
                      strapi.log.info(message);
                      let indexToken = contractBought.indexToken;
                      let lp = strapi.rollingData[`${indexToken}`].ticks[0];
                      let quantity = contractBought.quantity;
                      const orderStatus = await strapi.service('api::order.order').placeSellOrder({lp,index,indexToken,quantity}) || false;
                      if(orderStatus.status === true || orderStatus.status === 'true'){
                        let callOptionBought = false;
                        let callBoughtAt = 0;
                        let previousTradedPrice = 0;
                        let putOptionBought = false;
                        let putBoughtAt = 0;
                        strapi[`${index}`].set('stopLossThreshold', 0);   
                        strapi[`${index}`].set('profitThreshold', Infinity); 
                        strapi[`${index}`].set('downwardProfitTrigger', false);                  
                        // console.log('sell Order status true from variable service. Resetting awaitingOrderConfirmation to false');
                        strapi[`${contractBought.indexToken}`].set('callOptionBought', false);
                        strapi[`${contractBought.indexToken}`].set('callBoughtAt', 0);
                        strapi[`${contractBought.indexToken}`].set('putOptionBought', false);
                        strapi[`${contractBought.indexToken}`].set('putBoughtAt', 0);
                        strapi[`${contractBought.indexToken}`].set('awaitingOrderConfirmation', false);
                        strapi.db.query('api::variable.variable').update({
                              where: {indexToken : `${contractBought.indexToken}`},
                              data: {
                                callOptionBought,                  
                                previousTradedPrice,
                                callBoughtAt,
                                putBoughtAt,
                                putOptionBought,
                                awaitingOrderConfirmation: false,
                        }
                      });
                      }
                      if(orderStatus.status === false || orderStatus.status === 'false'){
                          // console.log('sell Order status false from variable service. Resetting awaitingOrderConfirmation to false');
                              strapi[`${contractBought.indexToken}`].set('awaitingOrderConfirmation', false);                      
                              strapi.db.query('api::variable.variable').update({
                                where: {indexToken : `${contractBought.indexToken}`},
                                data: {
                                  awaitingOrderConfirmation: false,
                                }
                              });                   
                      }        
                    }
                  }                          
                }
              }catch(error){
                console.log(error);
              }
            // }              
          }
        return { message: 'NFO Price updation received' }; 
      }           
    } else {      
      try {
        // Parse the lookback period once
        const lookbackPeriod = parseInt(env('SIDEWAYS_THRESHOLD_LOOKBACKPERIOD', 28), 10);
               
        // Sideways market detection strategy
        if (!strapi.rollingData[`${tk}`]) {
          strapi.rollingData[`${tk}`] = {
            prices_lookback_period: [],
            isSidewaysMarket: false,
            atrValues: [],
            // rsiSeries: [],
            currentADX: 0,
            currentRSI: 0,
            pcValues: [],
            bbwValues: [],
            dcwValues: [],
            adxValues: [],
            ticks: []                      
          };
        }
        
        // const rollingData = strapi.rollingData[`${tk}`];

        
       strapi.rollingData[`${tk}`].prices_lookback_period.push({ lp });
        if(strapi.rollingData[`${tk}`].prices_lookback_period.length > lookbackPeriod){
         strapi.rollingData[`${tk}`].prices_lookback_period.shift();
        }
        const isSidewaysMarket = await this.calculateSidewaysMarket(tk, strapi.rollingData[`${tk}`].prices_lookback_period);
        const index = strapi[`${tk}`].get('index') || tk;
        console.log('issidewaysMarket:',isSidewaysMarket)
      
       if (isSidewaysMarket === true && !strapi.rollingData[`${tk}`].isSidewaysMarket) {
            // Send a Strapi web broadcast to client regarding sideways market detection
            strapi.log.info(`Index ${index} entering a sideways market...`);
            strapi.webSocket.broadcast({
              type: 'market',
              message: `Index ${index} entering a sideways market.Trading not advised.. Pause for Stop loss...`,
              isSideWays: true,
              status: '001',
              tk
            });
            strapi.rollingData[`${tk}`].isSidewaysMarket = true;
        } else if (isSidewaysMarket === false && strapi.rollingData[`${tk}`].isSidewaysMarket) {
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
        }  else if(isSidewaysMarket === null ) {
          console.log(`Application trying to deduct market status for Index token ${index}...`);          
          strapi.webSocket.broadcast({
            type: 'market',
            message: `Application trying to deduct market status for Index token ${index}...`,
            isSideWays: false,
            status: '003',
            tk
          });
        } 
      }catch(error){
        console.log(`Some error calculating sideways market: ${error}`);
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
              callOptionBought, putOptionBought,callBoughtAt, putBoughtAt,index, indexToken,initialSpectatorMode,previousTradedPrice, amount, quantity, awaitingOrderConfirmation
            } = indexItem;


            function calculateEMA(values, period) {
              if (values.length < period) return null;
              const k = 2 / (period + 1);
              return values.reduce((prev, curr, i) => 
                  i === 0 ? curr : (curr * k + prev * (1 - k))
              );
            }
            
            let comparisonPrice;
            if(strapi.rollingData[`${tk}`].ticks.length > 14){
              strapi.rollingData[`${tk}`].ticks.shift();          
            }
           
            if(strapi.rollingData[`${tk}`].ticks.length > 1){
              comparisonPrice = calculateEMA(strapi.rollingData[`${tk}`].ticks, strapi.rollingData[`${tk}`].ticks.length );
            } else {
              comparisonPrice = lp;
            }
            // strapi.log.info(`Token: ${tk} LP: ${lp} Comparison price: ${parseFloat(comparisonPrice).toFixed(4)}`);
            strapi.rollingData[`${tk}`].ticks.push(parseFloat(parseFloat(lp).toFixed(4)));
           
            
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
              if((parseFloat(comparisonPrice) <= parseFloat(basePrice) + parseFloat(targetStep) && parseFloat(comparisonPrice) >= parseFloat(basePrice) - parseFloat(targetStep))
                || (parseFloat(comparisonPrice) <= parseFloat(resistance1) + parseFloat(targetStep) && parseFloat(comparisonPrice) >= parseFloat(resistance1) - parseFloat(targetStep))
                || (parseFloat(comparisonPrice) <= parseFloat(resistance2) + parseFloat(targetStep) && parseFloat(comparisonPrice) >= parseFloat(resistance2) - parseFloat(targetStep))
                || (parseFloat(comparisonPrice) <= parseFloat(support1) + parseFloat(targetStep) && parseFloat(comparisonPrice) >= parseFloat(support1) - parseFloat(targetStep))
                || (parseFloat(comparisonPrice) <= parseFloat(support2) + parseFloat(targetStep) && parseFloat(comparisonPrice) >= parseFloat(support2) - parseFloat(targetStep))
              ){
                //LP in investment hot zone. Turn off Spectator mode
                initialSpectatorMode = false;
                strapi[`${tk}`].set('initialSpectatorMode', initialSpectatorMode);
                strapi.db.query('api::variable.variable').update({
                  where: {indexToken: `${tk}`},
                  data: {initialSpectatorMode},
                });
                strapi.webSocket.broadcast({ type: 'variable', message: `Reaching strategic position.Spectator mode turned off for index ${index}`, status: true});
                strapi.log.info(`Reaching strategic position.Spectator mode turned off for index ${index}`);
              } else {
                //LP in Passive zone. Do not take any action
                strapi.log.info(`No actions taken for index ${index}. Comparison price: ${parseFloat(comparisonPrice).toFixed(4)} Previous Price: ${previousTradedPrice} LTP: ${lp}. Index in passive zone, InitialSpectatorMode: ${initialSpectatorMode}`);        
                previousTradedPrice = lp;
                strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);  
                strapi.webSocket.broadcast({ type: 'variable', message: `No actions taken for index ${index} at LTP ${lp}`, status: true});
                return `No actions taken at LTP ${lp}`;
              }
            }            
            
            if(strapi.isTradingEnabled){
              let contractType;           
              //Buy CALL
              if(!callOptionBought && !putOptionBought && !initialSpectatorMode && !strapi.rollingData[`${tk}`].isSidewaysMarket){                
                if(((parseFloat(comparisonPrice) >= parseFloat(basePrice) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(resistance1) - parseFloat(targetStep)) 
                  || (parseFloat(comparisonPrice) >= parseFloat(resistance1) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(resistance2) - parseFloat(targetStep))
                  || (parseFloat(comparisonPrice)>= parseFloat(resistance2) + parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) >= parseFloat(support1) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(basePrice) - parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) >= parseFloat(support2) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(support1) - parseFloat(targetStep)))
                  && parseFloat(lp) > parseFloat(comparisonPrice)
                  // && ( Math.max(comparisonPrice,previousTradedPrice) < lp)
                  // && (lp > comparisonPrice && (comparisonPrice > (resistance2 + parseFloat(targetStep)) || comparisonPrice > (resistance1 + parseFloat(targetStep)) || comparisonPrice > (basePrice + parseFloat(targetStep)) || comparisonPrice > (support1 + parseFloat(targetStep)) || comparisonPrice > (support2 + parseFloat(targetStep))))
                  && ((strapi.rollingData[`${tk}`].currentRSI >= 30 && strapi.rollingData[`${tk}`].currentRSI <= 70) || (strapi.rollingData[`${tk}`].currentRSI > 70 && strapi.rollingData[`${tk}`].currentADX > 30))
                ){
                  // console.table(strapi.rollingData[`${tk}`]);                 
                  //Buy CALL
                  callOptionBought = true;
                  callBoughtAt = comparisonPrice;
                  console.log(`Reached Strategic Buy zone for ${index}.Comparison price: ${parseFloat(comparisonPrice).toFixed(4)}. Previous Traded Price: ${previousTradedPrice}. Current Price: ${lp}. Application will attempt to buy CALL at Index RSI: ${strapi.rollingData[`${tk}`].currentRSI}`);
                  previousTradedPrice = lp;
                  awaitingOrderConfirmation = true;                  
                  strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                 
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy CALL at LTP ${lp} `, status: true});
                  contractType = 'CE';              
                  const orderStatus = await strapi.service('api::order.order').placeBuyOrder({contractType,lp,quantity,index,indexToken,amount});              
                  if(orderStatus.status === true || orderStatus.status === 'true'){
                    // console.log('CALL buy Order status true from variable service. Resetting awaitingOrderConfirmation to false');
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
                    // console.log('CALL buy Order status false from variable service. Resetting awaitingOrderConfirmation to false');
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
                  
                                     
                } else if(((parseFloat(comparisonPrice) <= parseFloat(basePrice) - parseFloat(targetStep) && parseFloat(comparisonPrice) > parseFloat(support1) + parseFloat(targetStep)) 
                  || (parseFloat(comparisonPrice) <= parseFloat(support1) - parseFloat(targetStep) && parseFloat(comparisonPrice) > parseFloat(support2) + parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) <= parseFloat(support2) - parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) <= parseFloat(resistance1) - parseFloat(targetStep) && parseFloat(comparisonPrice) > parseFloat(basePrice) + parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) <= parseFloat(resistance2) - parseFloat(targetStep) && parseFloat(comparisonPrice) > parseFloat(resistance1) + parseFloat(targetStep)))
                  // && (Math.min(comparisonPrice,previousTradedPrice) > lp)
                  && parseFloat(lp) < parseFloat(comparisonPrice)
                  && ((strapi.rollingData[`${tk}`].currentRSI >= 30 && strapi.rollingData[`${tk}`].currentRSI <= 70) || (strapi.rollingData[`${tk}`].currentRSI < 30 && strapi.rollingData[`${tk}`].currentADX > 30))
                ){
                  // console.table(strapi.rollingData[`${tk}`]);              
                  //Buy PUT                  
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy PUT at LTP ${lp}`, status: true});
                  console.log(`Reached Strategic Buy zone for ${index}.Comparison price: ${parseFloat(comparisonPrice).toFixed(4)}. Previous Traded Price: ${previousTradedPrice}. Current Price: ${lp} Application will attempt to buy PUT at & Index RSI: ${strapi.rollingData[`${tk}`].currentRSI}`);
                  contractType = 'PE';
                  putOptionBought = true;
                  putBoughtAt = comparisonPrice;
                  previousTradedPrice = lp;
                  awaitingOrderConfirmation = true;
                  strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                  const orderStatus = await strapi.service('api::order.order').placeBuyOrder({contractType,lp,quantity,index,indexToken, amount});
                  if(orderStatus.status === true || orderStatus.status === 'true'){
                    // console.log('PUT buy Order status true from variable service. Resetting awaitingOrderConfirmation to false');
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
                    // console.log('PUT buy Order status false from variable service. Resetting awaitingOrderConfirmation to false');
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
                
                if(
                  
                  (   (parseFloat(comparisonPrice) >= parseFloat(basePrice)   && (parseFloat(callBoughtAt) >= parseFloat(support1)    + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(basePrice)))   || ((parseFloat(comparisonPrice) <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (parseFloat(callBoughtAt) >= parseFloat(basePrice)   + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(resistance1)))) //Previously comparisonPrice<= basePrice at stop loss initial check
                  || ((parseFloat(comparisonPrice) >= parseFloat(resistance1) && (parseFloat(callBoughtAt) >= parseFloat(basePrice)   + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(resistance1))) || ((parseFloat(comparisonPrice) <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (parseFloat(callBoughtAt) >= parseFloat(resistance1) + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(resistance2)))) //Previously comparisonPrice<= resistance1 at stop loss initial check
                  || ((parseFloat(comparisonPrice) >= parseFloat(support1)    && (parseFloat(callBoughtAt) >= parseFloat(support2)    + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(support1)))    || ((parseFloat(comparisonPrice) <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (parseFloat(callBoughtAt) >= parseFloat(support1)    + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(basePrice)))) //Previously comparisonPrice<= support1 at stop loss initial check
                  || ((parseFloat(comparisonPrice) >= parseFloat(resistance2) && (parseFloat(callBoughtAt) >= parseFloat(resistance1) + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(resistance2))) || ((parseFloat(comparisonPrice) <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (parseFloat(callBoughtAt) >= parseFloat(resistance2) + parseFloat(targetStep)))) //Previously comparisonPrice<= resistance2 at stop loss initial check
                  || ((parseFloat(comparisonPrice) >= parseFloat(support2)    && parseFloat(callBoughtAt)   < parseFloat(support2))                                                                                    || ((parseFloat(comparisonPrice) <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (parseFloat(callBoughtAt) >= parseFloat(support2)    + parseFloat(targetStep) && parseFloat(callBoughtAt) < parseFloat(support1)))) //Previously comparisonPrice<= support2 at stop loss initial check
                ){              
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Sell zone for ${index}. Application will attempt to sell CALL at LTP ${lp}`, status: true});     
                  console.log(`Reached Strategic Sell zone for ${index}. Comparison price ${parseFloat(comparisonPrice).toFixed(4)} Previous Traed Price ${previousTradedPrice} Application will attempt to sell CALL at LTP ${lp}`);
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
                      strapi[`${index}`].set('downwardProfitTrigger', false);                  
                      // console.log('CALL sell Order status true from variable service. Resetting awaitingOrderConfirmation to false');
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
                      // console.log('CALL sell Order status false from variable service. Resetting awaitingOrderConfirmation to false');
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
                
                if(
                  // takeProfitTriggered
                  // || stopLossTriggered ||
                  (   (parseFloat(comparisonPrice) <= parseFloat(basePrice)   && (parseFloat(putBoughtAt) <= parseFloat(resistance1) - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(basePrice)))   || ((parseFloat(comparisonPrice) >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (parseFloat(putBoughtAt) <= parseFloat(basePrice)   - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(support1))))
                  || ((parseFloat(comparisonPrice) <= parseFloat(support1)    && (parseFloat(putBoughtAt) <= parseFloat(basePrice)   - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(support1)))    || ((parseFloat(comparisonPrice) >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (parseFloat(putBoughtAt) <= parseFloat(support1)    - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(support2))))
                  || ((parseFloat(comparisonPrice) <= parseFloat(resistance1) && (parseFloat(putBoughtAt) <= parseFloat(resistance2) - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(resistance1))) || ((parseFloat(comparisonPrice) >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (parseFloat(putBoughtAt) <= parseFloat(resistance1) - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(basePrice))))
                  || ((parseFloat(comparisonPrice) <= parseFloat(support2)    && (parseFloat(putBoughtAt) <= parseFloat(support1)    - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(support2)))    || ((parseFloat(comparisonPrice) >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (parseFloat(putBoughtAt) <= parseFloat(support2)    - parseFloat(targetStep))))
                  || ((parseFloat(comparisonPrice) <= parseFloat(resistance2) && (parseFloat(putBoughtAt)  > parseFloat(resistance2)))                                                                               || ((parseFloat(comparisonPrice) >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (parseFloat(putBoughtAt) <= parseFloat(resistance2) - parseFloat(targetStep) && parseFloat(putBoughtAt) > parseFloat(resistance1)))) //Stop loss at Resistance 2
                ){                            
                  
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Sell zone for ${index}. Application will attempt to sell PUT at LTP ${lp}`, status: true}); 
                  console.log(`Reached Strategic Sell zone for ${index}.Comparison price ${parseFloat(comparisonPrice).toFixed(4)} Previous Traded Price ${previousTradedPrice} Application will attempt to sell PUT at LTP ${lp}`);
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
                      strapi[`${index}`].set('downwardProfitTrigger', false);
                      // console.log('PUT sell Order status true from variable service. Resetting awaitingOrderConfirmation to false');
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
                      // console.log('PUT sell Order status false from variable service. Resetting awaitingOrderConfirmation to false');
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
      strapi.rollingData = {
        prices_lookback_period: [],
        isSidewaysMarket: false,
        atrValues: [],
        // rsiSeries: [],
        currentRSI: 0,
        currentADX: 0,
        pcValues: [],
        bbwValues: [],
        dcwValues: [],
        adxValues: [],
        ticks: []                       
      };
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

  
  async calculateSidewaysMarket(tk, data) {
    

    //Helper Functions-------------------------------------------------------------------------------------------

  
    // Calculate ADX
    function calculateADX(data, period) {
        let dmPlus = 0, dmMinus = 0, trSum = 0;
        let prevHigh = parseFloat(data[0].lp), prevLow = parseFloat(data[0].lp);

        for (let i = 1; i < data.length; i++) {
            let high = parseFloat(data[i].lp);
            let low = parseFloat(data[i].lp);

            let upMove = high - prevHigh;
            let downMove = prevLow - low;

            dmPlus += (upMove > downMove && upMove > 0) ? upMove : 0;
            dmMinus += (downMove > upMove && downMove > 0) ? downMove : 0;
            trSum += Math.max(high - low, Math.abs(high - prevLow), Math.abs(low - prevHigh));

            prevHigh = high;
            prevLow = low;
        }

        let diPlus = (dmPlus / trSum) * 100;
        let diMinus = (dmMinus / trSum) * 100;
        let dx = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;

        return dx;
    }

    // // Calculate Donchian Channel Width (DCW)
    // function calculateDCW(prices, period) {
    //     const highestHigh = Math.max(...prices.slice(-period));
    //     const lowestLow = Math.min(...prices.slice(-period));
    //     return ((highestHigh - lowestLow) / lowestLow) * 100;
    // }

    
    //Calculate ATR
    function calculateATR(data, period) {
      let trueRanges = [];
      for (let i = 1; i < data.length; i++) {
          let high = parseFloat(data[i].lp);
          let low = parseFloat(data[i - 1].lp);
          let previousClose = parseFloat(data[i - 1].lp);
          trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
      }
      return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
    }

    

   
    function calculateRSI(prices, period) {
      let gains = [], losses = [];
      for (let i = 1; i < prices.length; i++) {
          let change = prices[i] - prices[i - 1];
          gains.push(change > 0 ? change : 0);
          losses.push(change < 0 ? Math.abs(change) : 0);
      }

      let avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
      let avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;

      for (let i = period; i < gains.length; i++) {
          avgGain = (avgGain * (period - 1) + gains[i]) / period;
          avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      }

      let rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

    // Calculate Bollinger Band Width (BBW)
    function calculateBBW(prices, period) {
      const sma = prices.slice(-period).reduce((sum, price) => sum + price, 0) / period;
      const squaredDiffs = prices.slice(-period).map(price => Math.pow(price - sma, 2));
      const variance = squaredDiffs.reduce((sum, squaredDiff) => sum + squaredDiff, 0) / period;
      const stdDev = Math.sqrt(variance);
      const upperBand = sma + 2 * stdDev;
      const lowerBand = sma - 2 * stdDev;
      return ((upperBand - lowerBand) / sma) * 100;
    }

    //Calculate EMA
    function calculateEMA(values, period) {
      if (values.length < period) return null;
      const k = 2 / (period + 1);
      return values.reduce((prev, curr, i) => 
          i === 0 ? curr : (curr * k + prev * (1 - k))
      );
    }
  
    //---------------------------------------------------------------------------------------------------------------------

    //Factors & thresholds for Sideways market detection
    const lookbackPeriod = parseInt(env('SIDEWAYS_THRESHOLD_LOOKBACKPERIOD', 28), 10);
    const bbwThreshold1 = 0.025; // < 2% → Confirm sideways
    const bbwThreshold2 = 0.04; // Between 2%-4% → Check RSI
    const rsiThresholdLow = 40;
    const rsiThresholdHigh = 60;
    const adxThreshold = 20;            // ADX < 20 → No strong trend
    // const dcwThreshold = 0.03;          // DCW < 3% → No breakout

    //Sideways detection logic starts here....
   

    const prices = data.map(entry => parseFloat(entry.lp));
    const currentHigh = Math.max(...prices);
    const currentLow = Math.min(...prices);

    //Calculate ATR, Maintain ATR Rolling Data for ATR MA calculation & Calculate ATR Moving Average (ATR MA) & RSI 
    // const atrPeriod = data.length >= 21? 21 : data.length ;  
    const atr = calculateATR(data, data.length);      
    const rsi = calculateRSI(prices, prices.length) || 0;
    strapi.rollingData[`${tk}`].currentRSI = rsi;
    const bbw = calculateBBW(prices, prices.length);
    const adx = calculateADX(data, data.length) || 0;
    
    // const dcw = calculateDCW(prices, prices.length);   
    const percentageChange = ((currentHigh - currentLow) / currentLow) * 100;
    strapi.rollingData[`${tk}`].atrValues.push(atr);
    strapi.rollingData[`${tk}`].pcValues.push(percentageChange);
    strapi.rollingData[`${tk}`].bbwValues.push(bbw);
    // strapi.rollingData[`${tk}`].dcwValues.push(dcw);
    strapi.rollingData[`${tk}`].adxValues.push(adx);
    // console.table(strapi.rollingData[`${tk}`]);
    if(strapi.rollingData[`${tk}`].pcValues.length > lookbackPeriod ) strapi.rollingData[`${tk}`].pcValues.shift();
    if(strapi.rollingData[`${tk}`].bbwValues.length > lookbackPeriod ) strapi.rollingData[`${tk}`].bbwValues.shift();
    // if(strapi.rollingData[`${tk}`].dcwValues.length > lookbackPeriod ) strapi.rollingData[`${tk}`].dcwValues.shift();
    if(strapi.rollingData[`${tk}`].atrValues.length > lookbackPeriod - 7 ) strapi.rollingData[`${tk}`].atrValues.shift();
    if(strapi.rollingData[`${tk}`].adxValues.length > lookbackPeriod - 7 ) strapi.rollingData[`${tk}`].adxValues.shift();

    const adaptivePCThreshold = calculateEMA(strapi.rollingData[`${tk}`].pcValues, strapi.rollingData[`${tk}`].pcValues.length) || 2;
    const bbwEma = calculateEMA(strapi.rollingData[`${tk}`].bbwValues, strapi.rollingData[`${tk}`].bbwValues.length ) || bbw;
    // const dcwEma = calculateEMA(strapi.rollingData[`${tk}`].dcwValues, strapi.rollingData[`${tk}`].dcwValues.length ) || dcw;
    const atrMA = calculateEMA(strapi.rollingData[`${tk}`].atrValues, strapi.rollingData[`${tk}`].atrValues.length) || atr; 
    const adxEma = calculateEMA(strapi.rollingData[`${tk}`].adxValues, strapi.rollingData[`${tk}`].adxValues.length) || adx;
    strapi.rollingData[`${tk}`].currentADX = adxEma > 0 ? adxEma : adx;
    let dynamicRsiHigh = rsiThresholdHigh - (atr / atrMA) * 5;
    let dynamicRsiLow = rsiThresholdLow + (atr / atrMA) * 5;   
    console.log(`PC: ${percentageChange.toFixed(4)}, AdaptivePC: ${adaptivePCThreshold.toFixed(4)}, BBW: ${bbw.toFixed(4)} BBW EMA: ${bbwEma.toFixed(4)},  ATR: ${atr.toFixed(4)}, ATR MA: ${atrMA.toFixed(4)}, RSI: ${rsi.toFixed(4)}, Dynamic Low RSI: ${dynamicRsiLow.toFixed(4)}, Dynamic Low RSI: ${dynamicRsiLow.toFixed(4)} Dynamic High RSI: ${dynamicRsiHigh.toFixed(4)}, ADX: ${adx.toFixed(4)} ADX EMA: ${adxEma.toFixed(4)}, `);
    if (data.length < lookbackPeriod) return null; 

    // **Step 1: High-Low Percentage Change**
    if (percentageChange < parseFloat(adaptivePCThreshold) * 0.80) {
      console.info(`✅ PC (${percentageChange.toFixed(4)}) is within adaptive range  ${adaptivePCThreshold.toFixed(4)} ) → Sideways Market Confirmed`);
      return true;
    }

    if(percentageChange > parseFloat(adaptivePCThreshold) * 1.65) {
      console.info(`❌ Sudden spike in PC ${percentageChange.toFixed(4)} whereas moving average is ${adaptivePCThreshold.toFixed(4)} → Not a sideways`);  
    }

    // // **Step 2: Donchian Channel Width (DCW) with BBW Cross-Check**
    // if (parseFloat(dcwEma) < 3) {
    //   console.info(`✅ DCW EMA (${dcwEma.toFixed(4)}) < DCW Threshold 0.03 → Sideways Market Confirmed`);
    //   return true;
    // }

    // if(perce > dcwThreshold * 1.65){
    //   console.info(`❌ DCW EMA (${dcwEma.toFixed(4)}) > DCW Threshold ${dcwEma * 2} → NOT Sideways`);
    //   return false;
    // }

    // **Step 3: Bollinger Band Width (BBW) with Upper Bound Buffer**
    if (parseFloat(bbwEma) < bbwThreshold1) {
      console.info(`✅ BBW EMA (${bbwEma.toFixed(4)}) < ${bbwThreshold1}% → Sideways Market Confirmed`);
      return true;
    } 
    if (parseFloat(bbwEma) > bbwThreshold2 * 1.05) { // Added buffer
      console.info(`❌ BBW EMA (${bbwEma.toFixed(4)}) > ${bbwThreshold2 * 1.05}% → NOT Sideways`);
      return false;
    }

    // **Step 4: ADX Check**
    if (parseFloat(adxEma) < adxThreshold) {
      console.info(`✅ ADX EMA (${adxEma.toFixed(4)}) < ${adxThreshold} → Sideways Market Confirmed`);
      return true;
    }

    // **Step 5: ATR & RSI with Dynamic RSI Adjustment**
    // let dynamicRsiHigh = rsiThresholdHigh - (atr / atrMA) * 5;
    // let dynamicRsiLow = rsiThresholdLow + (atr / atrMA) * 5;
    if (atr < parseFloat(atrMA) * 1.05 && (rsi >= dynamicRsiLow && rsi <= dynamicRsiHigh)) {
      console.info(`✅ Final analysis with ATR (${atr.toFixed(4)}) < ATR MA x 1.05 times (${atrMA.toFixed(4)* 1.05}) & RSI (${rsi.toFixed(4)}) within dynamic RSI threshold (${dynamicRsiLow.toFixed(4)} - ${dynamicRsiHigh.toFixed(4)}) confirms a sideways market`);
      return true;
    }

    console.info(`❌ NOT Sideways`);
    return false;
    
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
          strapi.rollingData[`${entry.indexToken}`] = {
            prices_lookback_period: [],
            isSidewaysMarket: false,
            atrValues: [],
            // rsiSeries: [],
            currentRSI: 0,
            currentADX: 0,
            pcValues: [],
            bbwValues: [],
            dcwValues: [],
            adxValues: [],
            ticks: []                       
          };
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
      strapi.rollingData[`${indexToken}`] = {
        prices_lookback_period: [],
        isSidewaysMarket: false,
        atrValues: [],
        // rsiSeries: [],
        currentRSI: 0,
        currentADX: 0,
        pcValues: [],
        bbwValues: [],
        dcwValues: [],
        adxValues: [],
        ticks: []                       
      };
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
    strapi.rollingData = {
      prices_lookback_period: [],
      isSidewaysMarket: false,
      atrValues: [],
      // rsiSeries: [],
      currentRSI: 0,
      currentADX: 0,
      pcValues: [],
      bbwValues: [],
      dcwValues: [],
      adxValues: [],
      ticks: []                       
    };
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

        strapi[`${contract.index}`].set('contractTokens', contract.contractTokens || {
          ce: [],
          pe: [],        
        });
        
        
        const contractTokens = contract.contractTokens;
        contractTokens.ce.forEach(contract => {
          const {token, optt, tsym, ls, index} = contract;
          strapi[`${token}`] = new Map();
          strapi[`${token}`].set('optt', optt);
          strapi[`${token}`].set('tsym', tsym);
          strapi[`${token}`].set('ls', ls);
          strapi[`${token}`].set('index', index);
          strapi[`${token}`].set('rsi', 0);
          strapi[`${token}`].set('rsiSeries', []);
          strapi[`${token}`].set('prices', []);
        });
        contractTokens.pe.forEach(contract => {
          const {token, optt, tsym, ls, index} = contract;
          strapi[`${token}`] = new Map();
          strapi[`${token}`].set('optt', optt);
          strapi[`${token}`].set('tsym', tsym);
          strapi[`${token}`].set('ls', ls);
          strapi[`${token}`].set('index', index);
          strapi[`${token}`].set('rsi', 0);
          strapi[`${token}`].set('rsiSeries', []);
          strapi[`${token}`].set('prices', []);
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
          indexToken: position.indexToken
          
        }
        strapi[`${position.index}`].set('contractBought', contractBought);
        strapi[`${position.index}`].set('stopLossThreshold', 0);   
        strapi[`${position.index}`].set('profitThreshold', Infinity); 
        strapi[`${position.index}`].set('downwardProfitTrigger', false);
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

