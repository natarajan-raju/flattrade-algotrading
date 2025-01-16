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
                const realizedPL = (parseFloat(lp) * parseFloat(contractBought.quantity)) - parseFloat(contractBought.costPrice);              
                //send a Strapi web broadcast to client regarding the contract bought's token lp
                strapi.log.info(`Sending contract bought update to frontend for ${contractBought.contractToken}`);
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
        // const indexData = {
        //   tk,
        //   date: new Date(),
        //   volume: v,
        //   open: o,
        //   high: h,
        //   low: l,
        //   close: c,
        //   ap,
        //   lp,
        //   pc,
        //   e,
        // }  
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
              if(!callOptionBought && !putOptionBought && !initialSpectatorMode ){                
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
                if(
                  ((lp >= basePrice && (callBoughtAt >= parseFloat(support1) + parseFloat(targetStep) && callBoughtAt < basePrice)) || ((lp <= parseFloat(callBoughtAt)-parseFloat(lossStep)) && (callBoughtAt >= parseFloat(basePrice) + parseFloat(targetStep) && callBoughtAt < resistance1))) //Previously lp<= basePrice at stop loss initial check
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
                if(
                  ((lp <= basePrice && (putBoughtAt <= resistance1 - targetStep && putBoughtAt > basePrice)) || ((lp >= parseFloat(putBoughtAt) + parseFloat(lossStep)) && (putBoughtAt <= basePrice - targetStep && putBoughtAt > support1)))
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
  async getTimePriceData(indexToken, interval) {
    // console.log(indexToken,interval);
    //Check if intervals have values only as 1,3,5,10,15,30,60,120
    // if(interval != 1 || interval !== '3' || interval !== '5' || interval !== '10' || interval !== '15' || interval !== '30' || interval !== '60' || interval !== '120'){
    //   return {
    //     status: false,
    //     message: 'Interval should be 1,3,5,10,15,30,60,120'
    //   }
    // }
    //Current time in seconds since 1 Jan 1970
    const currentTime = Math.floor(Date.now() / 1000);

    //Create a Date object for today's 09:00 AM IST
    const now = new Date();
    const marketOpeningTime = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      9,
      0,
      0
    );
    
    //Convert the market opening time to seconds since 1 Jan 1970
    const startTime = Math.floor(marketOpeningTime.getTime() / 1000);
    console.log(startTime,currentTime);
    try{      
      const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","exch":"NSE","token":"${indexToken}","st":"${startTime}","et":"${currentTime}","intrv":"${interval}"}&jKey=${strapi.sessionToken}`;
      const timePriceResponse = await fetch(`${env('FLATTRADE_GET_TIME_PRICE_DATA_URL')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: payload,
      });
      const timePrice = await timePriceResponse.json();
      console.log(timePrice);
      return {
        status: true,
        data: timePrice,
        message: "Time price data fetched successfully for the given index token and interval"
      }
    }catch(error){
      console.log(`Error in getting time price data: ${error}`);
      return {
        status: false,
        message: error
      }
    }
    return {
      status: true,
      indexToken,
      interval
    }
  }
  
}));

