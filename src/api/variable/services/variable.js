'use strict';

const { env } = require('@strapi/utils');
const profit = require('../../profit/controllers/profit');
const contract = require('../../contract/controllers/contract');






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
      // console.log("option chain",optionChain);
      if(!optionChain.values){
        throw new Error('Option chain processing failed...');
      }
      // console.log('Reached stage 1');
      const contractTokens = {
        ce: [],
        pe: [],        
      };

      

      let scripList = `NSE|${indexToken}`;

      // Iterate over the option chain values to populate call and put objects
      optionChain.values.forEach(option => {
        const tokenData = { token: option.token, optt: option.optt, tsym: option.tsym, ls: option.ls, index, lp: 0, initialLP: 0 }; // Initialize lp as 0
        scripList += `#NFO|${option.token}`;
        if(option.optt === 'CE'){
          contractTokens.ce.push(tokenData);
        }else if(option.optt === 'PE'){
          contractTokens.pe.push(tokenData);
        }
        // console.log('Reached stage 2');
        strapi[`${option.token}`] = new Map();
        strapi[`${option.token}`].set('optt', option.optt);
        strapi[`${option.token}`].set('tsym', option.tsym);
        strapi[`${option.token}`].set('ls', option.ls);
        strapi[`${option.token}`].set('index', index);
        strapi[`${option.token}`].set('rsi', 0);
        // strapi[`${option.token}`].set('rsiSeries', []);
        strapi[`${option.token}`].set('prices', []);
        strapi[`${option.token}`].set('lp', 0);
        strapi[`${option.token}`].set('initialLP', 0);
        // contractTokens[`${option.token}`] = tokenData;
        // console.log('Reached stage 3');
      });
      if ((strapi[`${index}`]?.size ?? 0) === 0) {
        strapi[`${index}`] = new Map();
      }
    
      strapi[`${index}`].set('contractTokens', contractTokens);
      // try{
      //   strapi[`${index}`] && strapi[`${index}`].get('contractTokens');
      //   // console.log('Reached stage 4');
      // }catch(error){
      //   console.log(error);
      //   strapi[`${index}`] = new Map();
      //   strapi[`${index}`].get('contractTokens');

      // }

      
      
      
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
      console.log('reached final catch');
      throw new Error(error);

    }  
                                
  },

  //Trigger function to start market function analysis
  async startMarketAnalysis(indexToken) {
    const intervalId = setInterval(async () => {
      try{
        await strapi.service('api::variable.variable').analyzeMarketDirection(indexToken);
      }catch(error){
        console.log(error);
      }
    },30000);
    strapi[`${indexToken}`].set('intervalId', intervalId);
    console.log(`Market analysis started for ${indexToken} with interval ID ${intervalId}`);
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
          let { optt, index, tsym, ls, initialLP } = Object.fromEntries(strapi[`${tk}`]);
          if(parseFloat(lp) <= strapi.target && parseFloat(lp) >= strapi.entry * 0.80){
            strapi.log.info(`Price update for ${tsym}: ${lp} which has initialLP ${initialLP}`);
          }          
          if(strapi[`${index}`]){
            const contractTokens = strapi[`${index}`].get('contractTokens');
            let contractToken;
            //update the lp for current tk in contractTokens
            if(optt === 'CE'){
              contractToken = contractTokens.ce.find(item => item.token === tk);              
            } else if(optt === 'PE'){
              contractToken = contractTokens.pe.find(item => item.token === tk);
            }
            if(initialLP === 0){
              contractToken.initialLP = lp;
              contractToken.lp = lp;
              strapi[`${tk}`].set('initialLP', lp);
              strapi[`${tk}`].set('lp', lp);
              initialLP = lp;
              strapi[`${index}`].set('contractTokens', contractTokens);
              return;
            }
            contractToken.lp = lp;
            strapi[`${tk}`].set('lp', lp);
            strapi[`${index}`].set('contractTokens', contractTokens);
            
            // { token: option.token, optt: option.optt, tsym: option.tsym, ls: option.ls, index, lp: 0, initialLP: 0 } contract structure 
            // strapi.chosenContract = {token: null, lp: Infinity, tsym: null, ls: null, rsi: 0}; chosen contract structure 
            if(!strapi.preferredContracts.has(`${tk}`) 
              && !strapi.chosenContract 
              && (parseFloat(lp) >= 0.80 * strapi.entry) 
              && (parseFloat(lp) <= 0.95 *strapi.entry 
              && (parseFloat(initialLP) >= 0.80 * strapi.entry) 
              && (parseFloat(initialLP) <= 0.95 *strapi.entry)
              && strapi.amountBasedTradingEnabled
            )){
              console.log(`${tsym} with current price ${lp} & Initial LP ${initialLP} is added to preferred contracts & is under watchlist`);
              strapi.preferredContracts.add(`${tk}`);
              const selectedCandidate = {
                token: tk,
                lp,
                tsym,
                ls,
                initialLP
              }
              strapi.selectedCandidates.push(selectedCandidate);
              console.table(strapi.selectedCandidates);
              return;
            }
            
            //Check if this contract can be placed under Bracket order for Amount based trading
            if(strapi.preferredContracts.has(`${tk}`)){              
              strapi.log.info(`Price update for a preferred contract ${tsym}: ${lp}`);
              const foundContract = strapi.selectedCandidates.find(item => item.token === tk);
              foundContract.lp = lp;
              console.table(strapi.selectedCandidates);
              if(parseFloat(lp) >= strapi.entry && strapi.isTradingEnabled && parseFloat(lp) <= strapi.entry * 1.07){
                strapi.log.info(`Price for ${tsym} breached target ${strapi.entry} and is now the chosen target`);
                // // console.log(strapi.chosenContract);
                // strapi.preferredContracts = new Set();
                // strapi.selectedCandidates = [];
                strapi.webSocket.broadcast({
                  type: 'action',
                  message: `${tsym} with LP ${lp} is choosen for Amount based trading`,
                  status: true
                });
                let isOrderPlaced = await strapi.service("api::order.order").placeBracketOrder({
                  exchange: 'NFO',
                  tsym,
                  quantity: ls,
                  contractPrice:lp,
                  orderType: 'B',
                  remarks: 'Amount based order created from rajaapp.in',
                  index,
                });
                if(isOrderPlaced){
                  strapi.chosenContract = {token: tk, lp, tsym, ls, initialLP: lp, highestProfitStage: 0};
                  strapi.preferredContracts = new Set();
                  strapi.selectedCandidates = [];
                  console.log(`${tsym} with LP ${lp} is bought through bracket order for Amount based trading. Now watching for exit`);
                  return;                                   
                }               
              }
            }
            
            try{
              //Check if a contract is chosen and bought in amount based trading
              if(strapi.chosenContract){
                strapi.preferredContracts = new Set();
                strapi.selectedCandidates = [];
                if(strapi.chosenContract.token === tk){
                  strapi.chosenContract.lp = lp;
                  const gainOrLoss = parseFloat(lp) - strapi.chosenContract.initialLP;
                  strapi.log.info(`Price update for a chosen contract ${tsym}: ${lp} Gain/Loss: ${gainOrLoss}`);
                  let isProfitTrade = false;
                  let isLossTrade = false;
                  if(parseFloat(lp) >= strapi.target){
                    isProfitTrade = true;
                  }
                  if(parseFloat(lp) <= strapi.stopLoss){
                    isLossTrade = true;
                  }
                  const entryPrice = parseFloat(strapi.chosenContract.initialLP);
                  const profitStages = [
                    entryPrice + (0.30 * (strapi.target - entryPrice)) + 1,
                    entryPrice + (0.50 * (strapi.target - entryPrice)) + 1,
                    entryPrice + (0.75 * (strapi.target - entryPrice)) + 1,
                  ];

                    // Track highest stage reached
                  if (!strapi.chosenContract.highestProfitStage) {
                    strapi.chosenContract.highestProfitStage = 0;
                  }


                  // Determine if price reached a higher profit stage
                  for (let i = 0; i < profitStages.length; i++) {
                    if (parseFloat(lp) >= profitStages[i] && strapi.chosenContract.highestProfitStage < i + 1) {
                        strapi.chosenContract.highestProfitStage = i + 1;
                        // strapi.log.info(`Contract reached Profit Stage ${i + 1} at ${lp}`);
                    }
                  }
                  strapi.log.info(`Price update for a chosen contract ${tsym}: ${lp} Gain/Loss: ${gainOrLoss} Current Profit Stage ${strapi.chosenContract.highestProfitStage}`);

                  // If price falls below a locked stage, exit the trade
                  if ((strapi.chosenContract.highestProfitStage === 1 && parseFloat(lp) <= 1.01 * strapi.chosenContract.initialLP ) || (strapi.chosenContract.highestProfitStage > 1 && parseFloat(lp) <= profitStages[strapi.chosenContract.highestProfitStage - 1] * 0.98)) {
                    strapi.log.info(`Price for ${tsym} fell below locked stage, triggering exit at ${lp}`);

                    let isOrderPlaced = await strapi.service("api::order.order").placeBracketOrder({
                        exchange: 'NFO',
                        tsym,
                        quantity: ls,
                        contractPrice: lp,
                        orderType: 'S',
                        remarks: 'Profit lock triggered from rajaapp.in',
                        index,
                    });

                    if (isOrderPlaced) {
                        strapi.chosenContract = null;
                        console.log(`${tsym} with LP ${lp} is sold through bracket order for profit lock`);
                        if(await strapi.service('api::variable.variable').isBetween900And1030()){
                          strapi.log.info('Profit lock trade just happened. Will try to remonitor');
                          strapi.service('api::variable.variable').startAmountMonitoring(index, strapi.entry, strapi.target, strapi.stopLoss);
                        }
                        return { message: 'NFO Price updation received' }; 
                    } else {
                        strapi.webSocket.broadcast({
                            type: 'action',
                            message: `${tsym} with LP ${lp} was not sold through bracket order for profit lock`,
                            status: false
                        });
                    }
                  }

                  if(parseFloat(lp) >= strapi.target || parseFloat(lp) <= strapi.stopLoss){
                    strapi.log.info(`Price for ${tsym} breached and is now the exit target`);
                    //exchange,tsym,quantity,price,orderType,remarks="Order created from rajaapp.in"
                    // { exchange, tsym, quantity, contractPrice, orderType, remarks, index}
                    let isOrderPlaced = await strapi.service("api::order.order").placeBracketOrder({
                      exchange: 'NFO',
                      tsym,
                      quantity: ls,
                      contractPrice:lp,
                      orderType: 'S',
                      remarks: 'Amount based order created from rajaapp.in',
                      index,
                    });
                    if(isOrderPlaced){
                      strapi.chosenContract = null;
                      console.log(`${tsym} with LP ${lp} is sold through bracket order for Amount based trading`);
                      if(isLossTrade && await strapi.service('api::variable.variable').isBetween900And1030()){
                        console.log('As this is a Stop loss sell, Application will initiate Amount based trading once again');
                        strapi.service('api::variable.variable').startAmountMonitoring(index, strapi.entry, strapi.target, strapi.stopLoss); 
                        return { message: 'NFO Price updation received' }; 
                      }
                    }else{
                      strapi.webSocket.broadcast({
                        type: 'action',
                        message: `${tsym} with LP ${lp} is not sold through bracket order for Amount based trading`,
                        status: false
                      });
                    } 
                  }
                }
              }
            }catch(err){
              console.log(err);
            }
            //Check if a contract is bought for index based trading
              try{  
                const contractBought = strapi[`${index}`].get('contractBought') || null;            
                if((contractBought && contractBought.contractToken === tk)){
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
                    
                    // let profitThreshold = 4.10 * costPrice;            
                    // let profitStage = strapi[`${index}`].get('profitStage') || 0;
                    // // let roundedProfitStage = Math.floor(profitStage / 50) * 50;
                    // let profitStageThreshold = Math.max(0.50 * profitStage, profitStage - 187.5);
                    // if((profitStage === 0 && realizedPL >= 75) || (profitStage >=75 && realizedPL > profitStage)){
                    //   profitStage = Math.floor(realizedPL / 75) * 75;
                    //   strapi[`${index}`].set('profitStage', profitStage);
                    // } else if( profitStage > 0 && realizedPL <= profitStageThreshold) {                  
                    //   strapi[`${index}`].set('downwardProfitTrigger', true);
                    // }
                    // roundedProfitStage = Math.floor(profitStage / 50) * 50; 
                    // profitStageThreshold = Math.max(0.50 * profitStage, profitStage - 187.5);;                
                    const stopLossThreshold = 0.95 * costPrice;
                    strapi[`${index}`].set('currentValue', currentValue);                
                    strapi[`${index}`].set('stopLossThreshold', stopLossThreshold);
                    // strapi[`${index}`].set('profitThreshold', profitThreshold);
                    const contractUpdate = {
                      index,
                      // indexRSI: parseFloat(parseFloat(strapi.rollingData[`${contractBought.indexToken}`].currentRSI).toFixed(4)),
                      // indexToken: contractBought.indexToken,
                      contract: contractBought.tsym,
                      // contractRSI: parseFloat(parseFloat(strapi[`${tk}`].get('rsi')).toFixed(4)),
                      quantity: contractBought.quantity,
                      costPrice,
                      currentValue,
                      realizedPL,
                      // profitStage,
                      // profitTrigger: profitStageThreshold,
                      // profitThreshold,
                      stopLossTrigger: stopLossThreshold - costPrice,
                      // downwardProfitTrigger: strapi[`${index}`].get('downwardProfitTrigger'),
                      // awaitingOrderConfirmation
                    };                           
                    //send a Strapi web broadcast to client regarding the contract bought's token lp
                    // strapi.log.info(`${index} contract Cost Price: ${contractBought.costPrice} Current Value: ${parseFloat(lp) * parseFloat(contractBought.quantity)} Realized PL: ${realizedPL} Stop Loss sales will be triggered on or below ${stopLossThreshold}`);
                    console.table(contractUpdate);
                    
                    // let awaitingOrderConfirmation = strapi[`${contractBought.indexToken}`].get('awaitingOrderConfirmation');
                    if(currentValue <= stopLossThreshold){
                      strapi[`${contractBought.indexToken}`].set('awaitingOrderConfirmation', true);
                      let message = `Sell triggered as current value ${currentValue} gone below stoploss threshold ${stopLossThreshold}`;
                      // if(strapi[`${index}`].get('downwardProfitTrigger')) message = `Sell triggered as current value ${currentValue} gone below profit stage ${profitStage}`;
                      
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
                        // strapi[`${index}`].set('profitThreshold', Infinity); 
                        // strapi[`${index}`].set('downwardProfitTrigger', false);                  
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
      // Parse the lookback period once
      const lookbackPeriod = parseInt(env('SIDEWAYS_THRESHOLD_LOOKBACKPERIOD', 56), 10);     
      try {
        
               
        // Trending market detection strategy
        if (!strapi.rollingData[`${tk}`]) {
          strapi.rollingData[`${tk}`] = {
            prices_lookback_period: [],
            isTrendingMarket: false,
            atrValues: [],
            // rsiSeries: [],
            // currentADX: 0,
            // currentRSI: 0,
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
        const isTrendingMarket = await this.calculateTrendingMarket(tk, strapi.rollingData[`${tk}`].prices_lookback_period, lp);
        const index = strapi[`${tk}`].get('index') || tk;
        // console.log('isTrendingMarket:',isTrendingMarket)
      
       if (isTrendingMarket === false && strapi.rollingData[`${tk}`].isTrendingMarket) {
            // Send a Strapi web broadcast to client regarding sideways market detection
            strapi.log.info(`Index ${index} entering a Sideways market...`);
            strapi.webSocket.broadcast({
              type: 'market',
              message: `Index ${index} entering a sideways market.Trading not advised.. Pause for Stop loss...`,
              isSideWays: true,
              status: '001',
              tk
            });
            strapi.rollingData[`${tk}`].isTrendingMarket = false;
        } else if (isTrendingMarket === true && !strapi.rollingData[`${tk}`].isTrendingMarket) {
            // Broadcast sideways market end
            strapi.log.info(`Index ${index} exiting a sideways market...`);
            strapi.webSocket.broadcast({
              type: 'market',
              message: `Market is trending now for Index ${index}`,
              status: '002',              
              isSideWays: false,
              tk
            });
            strapi.rollingData[`${tk}`].isTrendingMarket = true;
        }  else if(isTrendingMarket === null ) {
          // console.log(`Application trying to deduct market status for Index token ${index}...`);          
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
      
        
          const headers = {
              Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Including the special token in the Authorization header
          };  
          //Try to fetch indexItem from local Map
          let indexItem;
          let buyCall = true;
          let buyPut = true;
          if(strapi[`${tk}`]){
            indexItem = Object.fromEntries(strapi[`${tk}`]);
            buyCall = indexItem.buyCall;
            buyPut = indexItem.buyPut;
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
            if(strapi.rollingData[`${tk}`].ticks.length >  56){
              strapi.rollingData[`${tk}`].ticks.shift();          
            }
            // console.log(strapi.rollingData[`${tk}`].ticks);
            if(strapi.rollingData[`${tk}`].ticks.length > 1){
              comparisonPrice = parseFloat(calculateEMA(strapi.rollingData[`${tk}`].ticks, strapi.rollingData[`${tk}`].ticks.length )).toFixed(4);
              // console.log(comparisonPrice);
            } else {
              comparisonPrice = lp;
            }
            // strapi.log.info(`Token: ${tk} LP: ${lp} Comparison price: ${parseFloat(comparisonPrice).toFixed(4)}`);
            strapi.rollingData[`${tk}`].ticks.push(lp);
           
            
            if (basePrice === 0 || resistance1 === 0 || resistance2 === 0 || support1 === 0 || support2 === 0){        
              return { message: `Investment variables not defined for ${index}`};
            } 
            feedData.cp = comparisonPrice;
            strapi.log.info(JSON.stringify(feedData));
            console.log(`Ready to buy CALL: ${buyCall}, Ready to buy PUT: ${buyPut}`);

            if(previousTradedPrice === 0){
              console.log(`First feed after submitting variables: Setting ${lp} as Last Traded Price for ${tk}`);
              // strapi[`${tk}`].set('currentOpen', lp);
              
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
              if(!callOptionBought && !putOptionBought && !initialSpectatorMode && strapi.rollingData[`${tk}`].isTrendingMarket){                
                if(((parseFloat(comparisonPrice) >= parseFloat(basePrice) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(resistance1) - parseFloat(targetStep)) 
                  || (parseFloat(comparisonPrice) >= parseFloat(resistance1) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(resistance2) - parseFloat(targetStep))
                  || (parseFloat(comparisonPrice)>= parseFloat(resistance2) + parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) >= parseFloat(support1) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(basePrice) - parseFloat(targetStep))
                  || (parseFloat(comparisonPrice) >= parseFloat(support2) + parseFloat(targetStep) && parseFloat(comparisonPrice) < parseFloat(support1) - parseFloat(targetStep)))
                  && parseFloat(lp) > parseFloat(comparisonPrice)
                  && buyCall
                  // && ( Math.max(comparisonPrice,previousTradedPrice) < lp)
                  // && (lp > comparisonPrice && (comparisonPrice > (resistance2 + parseFloat(targetStep)) || comparisonPrice > (resistance1 + parseFloat(targetStep)) || comparisonPrice > (basePrice + parseFloat(targetStep)) || comparisonPrice > (support1 + parseFloat(targetStep)) || comparisonPrice > (support2 + parseFloat(targetStep))))
                  // && ((strapi.rollingData[`${tk}`].currentRSI >= 30 && strapi.rollingData[`${tk}`].currentRSI <= 70) || (strapi.rollingData[`${tk}`].currentRSI > 70 && strapi.rollingData[`${tk}`].currentADX > 30))
                ){
                  // console.table(strapi.rollingData[`${tk}`]);                 
                  //Buy CALL
                  callOptionBought = true;
                  callBoughtAt = comparisonPrice;
                  console.log(`Reached Strategic Buy zone for ${index}.Comparison price: ${parseFloat(comparisonPrice).toFixed(4)}. Previous Traded Price: ${previousTradedPrice}. Current Price: ${lp}. Application will attempt to buy CALL `);
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
                  && buyPut
                  // && ((strapi.rollingData[`${tk}`].currentRSI >= 30 && strapi.rollingData[`${tk}`].currentRSI <= 70) || (strapi.rollingData[`${tk}`].currentRSI < 30 && strapi.rollingData[`${tk}`].currentADX > 30))
                ){
                  // console.table(strapi.rollingData[`${tk}`]);              
                  //Buy PUT                  
                  strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy PUT at LTP ${lp}`, status: true});
                  console.log(`Reached Strategic Buy zone for ${index}.Comparison price: ${parseFloat(comparisonPrice).toFixed(4)}. Previous Traded Price: ${previousTradedPrice}. Current Price: ${lp} Application will attempt to buy PUT`);
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
                      // strapi[`${index}`].set('profitThreshold', Infinity); 
                      // strapi[`${index}`].set('downwardProfitTrigger', false);                  
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
                      // strapi[`${index}`].set('profitThreshold', Infinity);
                      // strapi[`${index}`].set('downwardProfitTrigger', false);
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

  //Custom service function to handle Amount based trading
  async startAmountMonitoring(index,entry, target, stopLoss) {
    // strapi.log.info('Amount-based monitoring started for ', index, ' with:', `Entry price ${entry}, Target price ${target}, Stop loss ${stopLoss}`);
    console.log(`Amount based trading submitted for ${strapi.amountTradingCounter} th time`);
    strapi.target = target;
    strapi.stopLoss = stopLoss;
    strapi.entry = entry;
    strapi.chosenContract = null;
    strapi.selectedCandidates = [];
    strapi.preferredContracts = new Set();
    strapi.amountBasedTradingEnabled = true;
    // let callsNotFound = true;
    // let putsNotFound = true;
    // strapi.selectedCandidates = [];
    // let avoid = null; 
    // let preferredCalls = []; 
    // let preferredPuts = []; 
    // let minAmount = entry * 0.85;
    // let maxAmount = entry * 0.95;
  //   // strapi.tableContracts = new Map();
  //   function delayUntil915(callback) {
  //     const now = new Date().getTime(); // Get current time in milliseconds
  //     const targetTime = new Date();
  //     targetTime.setHours(9, 15, 0, 0); // Set target to 09:15:00 AM
  //     const targetTimestamp = targetTime.getTime(); // Convert target time to milliseconds
  
  //     let delay = targetTimestamp - now; // Calculate delay in milliseconds
  
  //     if (delay <= 0) {
  //         // console.log("It's already past 09:15 AM. Executing immediately.");
  //         callback();
  //     } else {
  //         console.log(`Waiting for ${Math.floor(delay / 1000)} seconds until 09:15 AM...`);
  //         setTimeout(callback, delay);
  //     }
  // }
  
  // // Example usage:
  // delayUntil915(() => {
  //     console.log("Executing Amount monitoringfunction as time above 09:15 AM!");
  // });

  // const contracts = await strapi.service('api::contract.contract').getPreferredContractsInRange(index, minAmount, maxAmount);
  
  
  //   while(preferredCalls.length === 0 || preferredPuts.length === 0){
      
  //     if (preferredCalls.length === 0) {
  //       preferredCalls = await strapi
  //         .service("api::order.order")
  //         .getPreferredContractsInRange(index, "CE", minAmount, maxAmount);       
             
  //     }

  //     if (preferredPuts.length === 0){
  //       preferredPuts = await strapi
  //         .service("api::order.order")
  //         .getPreferredContractsInRange(index, "PE", minAmount, maxAmount);      
  //     }

  //     if(preferredCalls.length > 0 && callsNotFound){
  //       strapi.log.info('Summary of identified CALL candidates');
  //       console.table(preferredCalls);
  //       for(const preferredCall of preferredCalls){
  //         console.log(`Identified CALL candidate ${preferredCall.tsym} with LP ${preferredCall.lp}`);
  //         strapi.preferredContracts.add(`${preferredCall.token}`);
  //       }
  //       callsNotFound = false;
        
  //     }

  //     if(preferredPuts.length > 0 && putsNotFound){
  //       strapi.log.info('Summary of identified PUT candidates');
  //       console.table(preferredPuts);
  //       for(const preferredPut of preferredPuts){
  //         console.log(`Identified PUT candidate ${preferredPut.tsym} with LP ${preferredPut.lp}`);
  //         strapi.preferredContracts.add(`${preferredPut.token}`);
  //       }
  //       putsNotFound = false;
        
  //     }

  //     if(strapi.chosenContract) return;
  //     await strapi.service("api::variable.variable").sleep(1500);
  //   }
    strapi.log.info('Amount-based monitoring started for ', index, ' with:', `Entry price ${entry}, Target price ${target}, Stop loss ${stopLoss}`);
    return;
  },


  // Custom function to reset investment variables
  async resetInvestmentVariables() {
    try {
      strapi.preferredContracts = new Set();
      strapi.rollingData = {
        prices_lookback_period: [],
        isTrendingMarket: false,
        atrValues: [],
        // rsiSeries: [],
        // currentRSI: 0,
        // currentADX: 0,
        pcValues: [],
        bbwValues: [],
        dcwValues: [],
        adxValues: [],
        ticks: []                       
      };
      const defaultValues = {
        open: 0,
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

  
  async calculateTrendingMarket(tk, data, lp) {
    

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
      if (data.length < period) return null; // Ensure enough LP data
      let trueRanges = [];
      for (let i = 1; i < data.length; i++) {
          let high = Math.max(data[i].lp, data[i - 1].lp);  // Dynamic High
          let low = Math.min(data[i].lp, data[i - 1].lp);   // Dynamic Low
          let previousClose = parseFloat(data[i - 1].lp);
          trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
      }
      return trueRanges.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
    }

    



    // Calculate Bollinger Band Width (BBW)
    function calculateBBW(prices, period) {
      const sma = prices.slice(-period).reduce((sum, price) => sum + price, 0) / period;
      const squaredDiffs = prices.slice(-period).map(price => Math.pow(price - sma, 2));
      const variance = squaredDiffs.reduce((sum, squaredDiff) => sum + squaredDiff, 0) / period;
      const stdDev = Math.sqrt(variance);
      const upperBand = sma + 2 * stdDev;
      const lowerBand = sma - 2 * stdDev;
      return {
        bbw: ((upperBand - lowerBand) / sma) * 100,
        upperBand,
        lowerBand
      };
    }

    // Calculate SD
    function calculateStandardDeviation(data) {
      if (!data.length || data.length < 2) return 0; // Handle empty array case
  
      const mean = data.reduce((sum, value) => sum + value, 0) / data.length;
      const squaredDiffs = data.map(value => Math.pow(value - mean, 2));
      const variance = squaredDiffs.reduce((sum, value) => sum + value, 0) / data.length;
  
      return Math.sqrt(variance);
  }

    // Calculate EMA
    function calculateEMA(values, period) {
      if (values.length < period) return null;
      const k = 2 / (period + 1);
      return values.reduce((prev, curr, i) => 
          i === 0 ? curr : (curr * k + prev * (1 - k))
      );
    }
  
  
    //---------------------------------------------------------------------------------------------------------------------

    //Factors & thresholds for Sideways market detection
    const lookbackPeriod = parseInt(env('SIDEWAYS_THRESHOLD_LOOKBACKPERIOD', 56), 10);   
    // const rsiThresholdLow = 40;
    // const rsiThresholdHigh = 60;
    // const adxThreshold = 20;            // ADX < 20 → No strong trend

    //Sideways detection logic starts here....
   

    const prices = data.map(entry => parseFloat(entry.lp));
    const currentHigh = Math.max(...prices);
    const currentLow = Math.min(...prices);

    //Calculate ATR, Maintain ATR Rolling Data for ATR MA calculation & Calculate ATR Moving Average (ATR MA) & RSI 
    // const atrPeriod = data.length >= 21? 21 : data.length ;  
    const atr = calculateATR(data, data.length) || 0;      
    // const rsi = calculateRSI(prices, prices.length) || 0;
    // strapi.rollingData[`${tk}`].currentRSI = rsi;
    const bbwCalculation = calculateBBW(prices, prices.length);
    const bbw = bbwCalculation.bbw;
    const upperBand = bbwCalculation.upperBand;
    const lowerBand = bbwCalculation.lowerBand;

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
    // const bbwSD = calculateStandardDeviation(strapi.rollingData[`${tk}`].bbwValues) || 0;
    // const bbwLowerThreshold = bbwEma - bbwSD || 0;
    const bbwHigherThreshold = parseFloat(bbwEma) || 0;
    const pcSD = calculateStandardDeviation(strapi.rollingData[`${tk}`].pcValues);
    const deviation = Math.max(1.5,Math.min(2.5, pcSD / adaptivePCThreshold));   
    const pcHigherThreshold = Math.max(parseFloat(adaptivePCThreshold) + (deviation * pcSD), parseFloat(adaptivePCThreshold) * 1.1);
    // const dcwEma = calculateEMA(strapi.rollingData[`${tk}`].dcwValues, strapi.rollingData[`${tk}`].dcwValues.length ) || dcw;
    const atrMA = calculateEMA(strapi.rollingData[`${tk}`].atrValues, strapi.rollingData[`${tk}`].atrValues.length) || atr; 
    const adxEma = calculateEMA(strapi.rollingData[`${tk}`].adxValues, strapi.rollingData[`${tk}`].adxValues.length) || adx;
    const atrSD = calculateStandardDeviation(strapi.rollingData[`${tk}`].atrValues);
    // strapi.rollingData[`${tk}`].currentADX = adxEma > 0 ? adxEma : adx;
    // let dynamicRsiHigh = rsiThresholdHigh - (atr / atrMA) * 5 || rsiThresholdHigh;
    // let dynamicRsiLow = rsiThresholdLow + (atr / atrMA) * 5 || rsiThresholdLow;   
    // console.log(`LP: ${lp} UpperBand: ${upperBand.toFixed(4)}, LowerBand: ${lowerBand.toFixed(4)}, PC: ${percentageChange.toFixed(4)}, AdaptivePC: ${pcHigherThreshold.toFixed(4)}, BBW: ${bbw.toFixed(4)} BBW Threshold: ${bbwHigherThreshold.toFixed(4)},  ATR: ${atr.toFixed(4)}, ATR Threshold: ${(parseFloat(atrMA) + atrSD * 0.5).toFixed(4)}, ADX: ${adx.toFixed(4)} ADX EMA: ${adxEma.toFixed(4)}, `);
    if (data.length < lookbackPeriod) return null; 

    // // **Step 1: High-Low Percentage Change**
    // if (percentageChange < pcLowerThreshold) {
    //   console.info(`✅ PC (${percentageChange.toFixed(4)}) is within adaptive range  ${pcLowerThreshold.toFixed(4)} → Sideways Market Confirmed`);
    //   return true;
    // }
    if(percentageChange > pcHigherThreshold &&
      (parseFloat(lp) < lowerBand || parseFloat(lp) > upperBand) &&
      bbw > bbwHigherThreshold &&
      (parseFloat(adxEma) > 25 && adx > 40) &&
      atr > (parseFloat(atrMA) + atrSD * 0.5)){
        console.log('✅ Trending Market');
      } 

    return (
      percentageChange > pcHigherThreshold &&
      (parseFloat(lp) < lowerBand || parseFloat(lp) > upperBand) &&
      bbw > bbwHigherThreshold &&
      (parseFloat(adxEma) > 25 && adx > 40) &&
      atr > (parseFloat(atrMA) + atrSD * 0.5) // Volatility filter
    );

    
  },

  //Cron function to stop market at 3.15pm daily
  async stopTrading(indexToken) {
    if(!indexToken){
        return {status: false, message: 'No token passed to stopTrading'};
    }
    strapi.amountBasedTradingEnabled = false;
    strapi.chosenContract = null;
    strapi.target = 0;
    strapi.entry = 0;
    strapi.stopLoss = 0;
    strapi.preferredContracts = new Set();
    strapi.amountTradingCounter = 0;
    


    
    const defaultValues = {
      open: 0,
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
            isTrendingMarket: false,
            atrValues: [],
            // rsiSeries: [],
            // currentRSI: 0,
            // currentADX: 0,
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
        isTrendingMarket: false,
        atrValues: [],
        // rsiSeries: [],
        // currentRSI: 0,
        // currentADX: 0,
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
           
          const variable = await strapi.db.query('api::variable.variable').update({
            where: { indexToken }, // Specify the condition for the update
            data: defaultValues,        // Specify the new data
          });
          const entries = Object.entries(variable);
          for (const [key, value] of entries) {
              strapi[`${indexToken}`].set(key, value);
          }
          // strapi[`${indexToken}`] = new Map(Object.entries(variable));
          console.log(`Application is stopping. For sample basePrice in ${indexToken} is ${strapi[`${indexToken}`].get('basePrice')}`);
          try{
            strapi[`${indexToken}`].get('intervalId') && clearInterval(strapi[`${indexToken}`].get('intervalId'));
          }catch(e){}

          //Check if any position is available in DB and clear it
          strapi.db.query('api::position.position').update({ where: { indexToken }, data: { contractType: '', contractToken: '',tsym: '',lotSize: '', quantity: 0, price: 0 } });
          const contractBought = {};
          strapi[`${variable.index}`].set('contractBought', contractBought);
          strapi.webSocket.broadcast({type: 'order', message: `Application is stopped now for index ${variable.index}.Please sell all positions before starting to trade again.`, status: true});
          return {status: true, message: `Application stopped now for index ${variable.index}...`};        
      
    }
  },



  async fetchIndexVariables(){
    strapi.rollingData = {
      prices_lookback_period: [],
      isTrendingMarket: false,
      atrValues: [],
      // rsiSeries: [],
      // currentRSI: 0,
      // currentADX: 0,
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
          strapi[`${token}`].set('lp', 0);
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
          strapi[`${token}`].set('lp', 0);
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
        // strapi[`${position.index}`].set('profitThreshold', Infinity); 
        // strapi[`${position.index}`].set('downwardProfitTrigger', false);
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
      try{
        strapi[`${indexItem.indexToken}`].set('buyCall',true);
        strapi[`${indexItem.indexToken}`].set('buyPut',true);
        strapi[`${indexItem.indexToken}`].set('eod',indexItem.eod);      
        strapi[`${indexItem.indexToken}`].get('intervalId') && clearInterval(strapi[`${indexItem.indexToken}`].get('intervalId'));
      }catch(error){
        console.log(error);
      }  
      try {
        strapi.service('api::variable.variable').startMarketAnalysis(indexItem.indexToken);
        // await strapi.service('api::variable.variable').analyzeMarketDirection(indexToken);
      } catch (error) {
        console.log(error);
      }
                
        
      }      
    } 
    
    strapi.log.info('Variables fetched...');  
  },

  //Get Quote
  async getQuote(indexToken, updateDB) {    
    try{      
        const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","exch":"NSE","token":"${indexToken}"}&jKey=${strapi.sessionToken}`;
        const quoteResponse = await fetch(`${env('FLATTRADE_GET_QUOTES_URL')}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: payload,
        });
        const quote = await quoteResponse.json();
        // console.log(quote);
        if(quote.h && quote.l && quote.c && updateDB){
          // console.log(indexToken, quote.h, quote.l);
          strapi.db.query('api::variable.variable').update({
            where: {
              indexToken: indexToken
            },
            data: {
              eod: {
                high: quote.h,
                low: quote.l,
                requestTime: quote.request_time,
                close: quote.c
              }              
            }
          });
        }        
      return quote;
    }catch(error){
      console.warn(error);
      return null;
    }
  },

  //Fetch time price data from flattrade
  async getTimePriceData(indexToken, interval, startDate, exchange="NSE") {
    const currentDate = new Date();
    console.log(exchange);
    // Calculate startTime and endTime
    const startTime = new Date(startDate).getTime() / 1000;
    const endTime = Math.floor(currentDate.getTime() / 1000);

    // console.log(`StartTime: ${startTime}, EndTime: ${endTime}, Interval: ${interval}`);

    try {
        const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","exch":"${exchange}","token":"${indexToken}","st":"${startTime}","et":"${endTime}","intrv":"${interval}"}&jKey=${strapi.sessionToken}`;
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
        console.log(error);
        return {
            status: false,
            message: `${error}`,
            data: [],
        };
    }
  },

  

  //Determine Market direction
  async analyzeMarketDirection(indexToken) {
    // console.log('test');
    if(strapi.isTradingEnabled === false) return;
    let openValueChanged = false;

    let currentOpen, prevHigh, prevLow, prevClose;
    currentOpen = strapi[`${indexToken}`].get('open') || await strapi.db.query('api::variable.variable').findOne({where: {indexToken}}).open || await strapi.service('api::variable.variable').getQuote(indexToken, false).o;          
    prevHigh = strapi[`${indexToken}`].get('eod').high || strapi.db.query('api::variable.variable').findOne({where: {indexToken}}).eod.high;
    prevLow = strapi[`${indexToken}`].get('eod').low || strapi.db.query('api::variable.variable').findOne({where: {indexToken}}).eod.low;
    prevClose = strapi[`${indexToken}`].get('eod').close || strapi.db.query('api::variable.variable').findOne({where: {indexToken}}).eod.close;
    
    // console.log(`Previous high: ${prevHigh} Previous low: ${prevLow} PreviousCurrent open: ${currentOpen}`);
    try {
        const interval = 1; // 1-minute candles
        const currentDate = new Date();
        let calculatedStartDate = new Date(currentDate);
        calculatedStartDate.setHours(0, 0, 0, 0);
        
        // Fetch today's candle data
        const response = await strapi.service('api::variable.variable').getTimePriceData(indexToken, interval, calculatedStartDate.toISOString());
        // Get the latest and previous candle
        const candles = response.data;     
        
       if(response.status && response.data.length > 1) {
          const currentCandle = candles[0];         
          currentOpen = currentCandle.open;
          openValueChanged = true;
                
        }    
    } catch (error) {
        console.error(`Error in market analysis: ${error}`);
        // strapi.service('api::variable.variable').analyzeMarketDirection(indexToken);
        throw new Error(error);
    }    
    openValueChanged && strapi.db.query('api::variable.variable').update({where: {indexToken}, data: {open: currentOpen}});     
    if (parseFloat(currentOpen) >= parseFloat(prevHigh) - 10) {
            strapi[`${indexToken}`].set('buyCall', false) // Market may go down
            strapi[`${indexToken}`].set('buyPut', true) // Market may go down
    } else if (parseFloat(currentOpen) <= parseFloat(prevLow) + 10) {
            strapi[`${indexToken}`].set('buyCall', true); // Market may go up;
            strapi[`${indexToken}`].set('buyPut', false); // Market may go up;
    } else if ((parseFloat(currentOpen) <= parseFloat(prevClose) + 10) && parseFloat(currentOpen) >= parseFloat(prevClose) - 10) {
            strapi[`${indexToken}`].set('buyCall', true); // Market may move in any direction
            strapi[`${indexToken}`].set('buyPut', true); // Market may move in any direction
    } else {
            strapi[`${indexToken}`].set('buyCall', false); // Market may move in any direction
            strapi[`${indexToken}`].set('buyPut', false); // Market may move in any direction
    }
        strapi.log.info('Market analysis completed');
        console.table({
          "Current Open": currentOpen,
          "Previous High": prevHigh,
          "Previous Low": prevLow,
          "Previous Close": prevClose,
          "Buy Call": strapi[`${indexToken}`].get('buyCall'),
          "Buy Put": strapi[`${indexToken}`].get('buyPut'),
        });
        
       
  },

  // Helper: Check if time is between 9:15 and 10:30
  async isBetween900And1030() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    return (h === 9 || h === 10 && m < 31);
  },

  // Helper: Sleep for ms
  async sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
  },

  
  // }

  
  
}));

