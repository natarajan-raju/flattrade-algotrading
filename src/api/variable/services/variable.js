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
      
      // Prepare the payload for the option chain request
      const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","tsym":"${sampleContractTsym}","exch":"NFO","strprc":"${sampleContractTsym.slice(-5)}","cnt":"400"}&jKey=${sessionToken}`;
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
      };

      let scripList = `NSE|${indexToken}#`;

      // Iterate over the option chain values to populate call and put objects
      optionChain.values.forEach(option => {
        const tokenData = {  optt: option.optt, tsym: option.tsym, ls: option.ls, index }; // Initialize lp as 0
        scripList += `NFO|${option.token}#`;
        strapi[`${option.token}`] = new Map();
        strapi[`${option.token}`].set('optt', option.optt);
        strapi[`${option.token}`].set('tsym', option.tsym);
        strapi[`${option.token}`].set('ls', option.ls);
        strapi[`${option.token}`].set('index', index);
        contractTokens[`${option.token}`] = tokenData;
        
      });

      
      
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

    const { lp, tk, e, pc, v, o, h, l, c, ap } = feedData;
    if(!lp){
      return { message: 'Not a LTP message' };
    } 
    // Tokens for buy/sell operations
    const buySellTokens = new Set(['26000', '26009', '26013', '26014', '26037']);
    if (!buySellTokens.has(tk)) {     
      //NFO Price update received. Update lp for contract token
      const { optt, index } = Object.fromEntries(strapi[`${tk}`]);
      let { preferredCallToken, preferredPutToken, preferredCallTokenLp, preferredPutTokenLp, amount } = Object.fromEntries(strapi[`${index}`]);
      if(optt === 'CE' && lp >= amount && lp < preferredCallTokenLp){
        preferredCallToken = tk;
        preferredCallTokenLp = lp;
        strapi[`${index}`].set('preferredCallTokenLp', lp);
        strapi[`${index}`].set('preferredCallToken', tk);
      }else if(optt === 'PE' && lp >= amount && lp < preferredPutTokenLp){
        preferredPutToken = tk;
        preferredPutTokenLp = lp;
        strapi[`${index}`].set('preferredPutTokenLp', lp);
        strapi[`${index}`].set('preferredPutToken', tk);
      }
      strapi.db.query('api::contract.contract').update(
        { where: { index },
          data: {
            preferredCallToken,
            preferredPutToken,
            preferredCallTokenLp,
            preferredPutTokenLp          
          }
       });

      return { message: 'NFO Price updation received' };      
    } else {
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
          console.log('Fetching from database.. Please check map allocation');
          indexItem = await strapi.db.query('api::index.index').findOne({
            where: { indexToken: tk },
          });
        }

        // Extract variables of the index
          let {
            basePrice, resistance1, resistance2, support1, support2, targetStep,
            callOptionBought, putOptionBought,callBoughtAt, putBoughtAt, indexToken, index,initialSpectatorMode,previousTradedPrice, amount, quantity, awaitingOrderConfirmation
          } = indexItem;
          
      
          if (basePrice === 0 || resistance1 === 0 || resistance2 === 0 || support1 === 0 || support2 === 0){        
            return { message: `Investment variables not defined for ${index}`};
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
            if((lp <= basePrice + targetStep && lp >= basePrice - targetStep)
              || (lp <= resistance1 + targetStep && lp >= resistance1 - targetStep)
              || (lp <= resistance2 + targetStep && lp >= resistance2 - targetStep)
              || (lp <= support1 + targetStep && lp >= support1 - targetStep)
              || (lp <= support2 + targetStep && lp >= support2 - targetStep)
            ){
              //LP in investment hot zone. Turn off Spectator mode
              initialSpectatorMode = false;
              strapi[`${tk}`].set('initialSpectatorMode', initialSpectatorMode);
              strapi.db.query('api::variable.variable').update({
                where: {indexToken: `${tk}`},
                data: {initialSpectatorMode},
              });
              strapi.webSocket.broadcast({ type: 'variable', message: `Reaching strategic position.Spectator mode turned off for index ${index}`, status: true});
              console.log('Reaching strategic position.Spectator mode turned off');
            } else {
              //LP in Passive zone. Do not take any action
              previousTradedPrice = lp;
              strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);          
              strapi.webSocket.broadcast({ type: 'variable', message: `No actions taken for index ${index} at LTP ${lp}`, status: true});
              return `No actions taken at LTP ${lp}`;
            }
          }
          
          
          let contractType;   
          
          //Buy CALL
          if(!callOptionBought && !putOptionBought && !initialSpectatorMode ){
            
            if(((lp >= basePrice + targetStep && lp < resistance1 - targetStep) 
              || (lp >= resistance1 + targetStep && lp < resistance2 - targetStep)
              || (lp>= resistance2 + targetStep)
              || (lp >= support1 + targetStep && lp < basePrice - targetStep)
              || (lp >= support2 + targetStep && lp < support1 - targetStep))
              && (previousTradedPrice === 0 || previousTradedPrice < lp)
            ){
              
              
              //Buy CALL
              callOptionBought = true;
              callBoughtAt = lp;
              previousTradedPrice = lp;
              awaitingOrderConfirmation = true;
              strapi[`${tk}`].set('callOptionBought', callOptionBought);
              strapi[`${tk}`].set('callBoughtAt', callBoughtAt);
              strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
              strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);              
              strapi.db.query('api::variable.variable').update({
                where: {indexToken : `${tk}`},
                data: {
                  callOptionBought,
                  callBoughtAt,
                  previousTradedPrice,
                  awaitingOrderConfirmation,
                }
              });
              
              strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy CALL at LTP ${lp}`, status: true});
              contractType = 'CE';              
              await strapi.service('api::order.order').placeBuyOrder({contractType,lp,quantity,index,indexToken});
              return {
                  status: true,
                  message: 'CALL buy Order placed successfully',
                  
              }                         
            } else if(((lp <= basePrice - targetStep && lp > support1 + targetStep) 
              || (lp <= support1 - targetStep && lp > support2 + targetStep)
              || (lp <= support2 - targetStep)
              || (lp <= resistance1 - targetStep && lp > basePrice + targetStep)
              || (lp <= resistance2 - targetStep && lp > resistance1 + targetStep))
              && (previousTradedPrice === 0 || previousTradedPrice > lp)
            ){             
              //Buy PUT 
              
              contractType = 'PE';
              putOptionBought = true;
              putBoughtAt = lp;
              previousTradedPrice = lp;
              awaitingOrderConfirmation = true;
              strapi[`${tk}`].set('putOptionBought', putOptionBought);
              strapi[`${tk}`].set('putBoughtAt', putBoughtAt);
              strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
              strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
              strapi.db.query('api::variable.variable').update({
                where: {indexToken : `${tk}`},
                data: {              
                  putOptionBought,
                  putBoughtAt,
                  previousTradedPrice,
                  awaitingOrderConfirmation
                }
              });
              
              strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy PUT at LTP ${lp}`, status: true});
              await strapi.service('api::order.order').placeBuyOrder({contractType,lp,quantity,index,indexToken});
              return {
                status: true,
                message: 'PUT buy Order placed successfully',                            
              }                           
            }
          }
      
          //Sell CALL
          if(callOptionBought){
            if(
              ((lp >= basePrice && (callBoughtAt >= support1 + targetStep && callBoughtAt < basePrice)) || (lp <= basePrice && (callBoughtAt >= basePrice + targetStep &&callBoughtAt < resistance1)))
              || ((lp >= resistance1 && (callBoughtAt >= basePrice + targetStep && callBoughtAt < resistance1)) || (lp <= resistance1 && (callBoughtAt >= resistance1 + targetStep && callBoughtAt < resistance2)))
              || ((lp >= support1 && (callBoughtAt >= support2 + targetStep && callBoughtAt < support1)) || (lp <= support1 && (callBoughtAt >= support1 + targetStep && callBoughtAt < basePrice)))
              || ((lp >=resistance2 && (callBoughtAt >= resistance1 + targetStep && callBoughtAt < resistance2)) || (lp <= resistance2 && callBoughtAt  >= resistance2 + targetStep)) 
              || ((lp >= support2 && callBoughtAt < support2) || (lp <= support2 && (callBoughtAt >= support2 + targetStep && callBoughtAt < support1))) //Stop loss at Support 2
            ){              
              strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Sell zone for ${index}. Application will attempt to sell CALL at LTP ${lp}`, status: true});     
              //call sell API
              
                contractType = 'CE';              
                callOptionBought = false; 
                callBoughtAt = 0;             
                previousTradedPrice = lp;
                awaitingOrderConfirmation = true;
                strapi[`${tk}`].set('callOptionBought', callOptionBought);
                strapi[`${tk}`].set('callBoughtAt', callBoughtAt);
                strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
                strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                strapi.db.query('api::variable.variable').update({
                  where: {indexToken : `${tk}`},
                  data: {
                    callOptionBought,                  
                    previousTradedPrice,
                    callBoughtAt,
                    awaitingOrderConfirmation
                  }
                });
                await strapi.service('api::order.order').placeSellOrder({contractType,lp,index,indexToken,quantity});
                return {
                  status: true,
                  message: 'CALL sell Order placed successfully',
                           
                }                                                 
            }
          }
      
          //Sell PUT
          if(putOptionBought){
            if(
              ((lp <= basePrice && (putBoughtAt <= resistance1 - targetStep && putBoughtAt > basePrice)) || (lp >= basePrice && (putBoughtAt <= basePrice - targetStep && putBoughtAt > support1)))
              || ((lp <= support1 && (putBoughtAt <= basePrice - targetStep && putBoughtAt > support1)) || (lp >= support1 && (putBoughtAt <= support1 - targetStep && putBoughtAt > support2)))
              || ((lp <= resistance1 && (putBoughtAt <= resistance2 - targetStep && putBoughtAt > resistance1)) || (lp >= resistance1 && (putBoughtAt <= resistance1 - targetStep && putBoughtAt > basePrice)))
              || ((lp <= support2 && (putBoughtAt <= support1 - targetStep && putBoughtAt > support2)) || (lp >= support2 && putBoughtAt <= support2 - targetStep))
              || ((lp <= resistance2 && putBoughtAt > resistance2) || (lp >= resistance2 && (putBoughtAt <= resistance2 - targetStep && putBoughtAt > resistance1))) //Stop loss at Resistance 2
            ){                            
              strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Sell zone for ${index}. Application will attempt to sell PUT at LTP ${lp}`, status: true}); 
              //PUT sell API 
             
                contractType = 'PE';             
                putOptionBought = false;  
                putBoughtAt = 0;            
                previousTradedPrice = lp;
                awaitingOrderConfirmation = true;
                strapi[`${tk}`].set('putOptionBought', putOptionBought);
                strapi[`${tk}`].set('putBoughtAt', putBoughtAt);
                strapi[`${tk}`].set('previousTradedPrice', previousTradedPrice);
                strapi[`${tk}`].set('awaitingOrderConfirmation', awaitingOrderConfirmation);
                let updatedVariable = await strapi.db.query('api::variable.variable').update({
                  where: {indexToken: `${tk}`},
                  data: {
                    putOptionBought,                  
                    previousTradedPrice,
                    putBoughtAt,
                    awaitingOrderConfirmation
                  }           
                });
                await strapi.service('api::order.order').placeSellOrder({contractType,lp,index,indexToken,quantity});
                return {
                  status: true,
                  message: 'PUT sell Order placed successfully',
                  updatedVariable,
                }                          
            }
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
      strapi.webSocket.broadcast({ type: 'action',message: "Investment variables reset", status: true, });
         
    } catch (error) {
      strapi.webSocket.broadcast({ type: 'action',message: "Error resetting investment variables. Please reset all variables", status: false, });
        
    }
  },

  //Cron function to stop market at 3.15pm daily
  async stopTrading(indexToken) {
    if(!indexToken){
        return {status: false, message: 'No token passed to stopTrading'};
    }
   
    const scrip = await strapi.db.query('api::web-socket.web-socket').findOne({where: { indexToken }}); 
    strapi.service('api::web-socket.web-socket').unsubsribeTouchline(scrip.scripList);
    strapi.db.query('api::web-socket.web-socket').update({where: { indexToken }, data: { scripList: '' }});
    const defaultValues = {
      basePrice: 0,
      resistance1: 0,
      resistance2: 0,
      support1: 0,
      support2: 0,
      amount: 0,
      quantity: 0,
      previousTradedPrice: 0,                                
    };
    const headers = {
      Authorization: `Bearer ${env('SPECIAL_TOKEN')}`,
    };
    if(indexToken === '1'){
        
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
          strapi[`${entry.index}`].clear();
          strapi[`${entry.indexToken}`].clear();
        }        
        strapi.webSocket.broadcast({type: 'action', message: 'Application is stopped now.Please sell all positions before starting to trade again.', status: true});
        return {status: true, message: 'Application stopped now..'};      
    }else{
      const variable = await strapi.db.query('api::variable.variable').findOne({
        where: { indexToken },
      });
      if(variable){
        if(variable.callOptionBought){
          strapi.webSocket.broadcast({type: 'variable',message: 'Please sell all positions before starting to trade again.', status: true});        
        }else{
          defaultValues.initialSpectatorMode = true;
        }      
          strapi.db.query('api::variable.variable').update({
            where: { id: variable.id }, // Specify the condition for the update
            data: defaultValues,        // Specify the new data
          });
          strapi[`${indexToken}`].clear();
          strapi[`${variable.index}`].clear();
          strapi.webSocket.broadcast({type: 'action', message: `Application is stopped now for index ${variable.index}.Please sell all positions before starting to trade again.`, status: true});
          return {status: true, message: `Application stopped now for index ${variable.index}...`};        
      }
    }
  },



  async fetchIndexVariables(){
    
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
        strapi[`${contract.index}`].set('preferredCallToken', contract.preferredCallToken);
        strapi[`${contract.index}`].set('preferredPutToken', contract.preferredPutToken);
        strapi[`${contract.index}`].set('preferredCallTokenLp', contract.preferredCallTokenLp || Infinity);
        strapi[`${contract.index}`].set('preferredPutTokenLp', contract.preferredPutTokenLp || Infinity);
        
        
        const contractTokens = contract.contractTokens;
        for (const [token, tokenData] of Object.entries(contractTokens)) {
          strapi[`${token}`] = new Map();
          strapi[`${token}`].set('optt', tokenData.optt);
          strapi[`${token}`].set('tsym', tokenData.tsym);
          strapi[`${token}`].set('ls', tokenData.ls);
          strapi[`${token}`].set('index', tokenData.index);
          
        }      
      }
    }

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
          lotSize: position.lotSize,
        }
        strapi[`${position.index}`].set('contractBought', contractBought);
      }
    }
    
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
        if(strapi[`${indexItem.index}`]){
          strapi[`${indexItem.index}`].set('amount', indexItem.amount);
        }
               
        
      }      
    }   
  },
  
}));

