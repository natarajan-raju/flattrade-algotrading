'use strict';
const fs = require( 'fs' );
const { env } = require('@strapi/utils');

/**
 * variable service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::variable.variable', ({ strapi }) => ({
  //Process option chain and retrieve relevant Contracts for the given Expiry date
  async processOptionChain(sampleContractTsym, sessionToken) {
    try {
      // Prepare the payload for the option chain request
      const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","tsym":"${sampleContractTsym}","exch":"NFO","strprc":"${sampleContractTsym.slice(-5)}","cnt":"500"}&jKey=${sessionToken}`;
      const optionChainResponse = await fetch(`${env('FLATTRADE_OPTION_CHAIN_URL')}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: payload,
      });

      // Parse the response JSON
      const optionChain = await optionChainResponse.json();
      if(!optionChain){
        return { message: 'Option chain not found', status: false };
      }
      // Initialize the contractTokens structure with objects holding token and initial lp as 0
      const contractTokens = {
        call: [],
        put: [],
      };

      // Iterate over the option chain values to populate call and put objects
      optionChain.values.forEach(option => {
        const tokenData = { token: option.token, lp: 0, tsym: option.tsym, ls: option.ls }; // Initialize lp as 0

        if (option.optt === 'CE') {
          contractTokens.call.push(tokenData);
        } else if (option.optt === 'PE') {
          contractTokens.put.push(tokenData);
        }
      });
      
      // Update the contract in the database with contractTokens including token and lp
      await strapi.db.query('api::contract.contract').update({
        where: { sampleContractTsym },
        data: {
          contractTokens,
        },
      });

      return { contractTokens, message: 'Option chain processed successfully', status: true };

    } catch (error) {
      console.error("Error processing option chain:", error);
      return { message: error.message || 'An error occurred while processing the option chain.', status: false };
    }
  },

  //Custom service function to handle trade logic basis Flattrade touchline feed
  async handleFeed(feedData) {

    const { lp, tk, e } = feedData;
    if(!lp){
      return { message: 'Not a LTP message' };
    } 
    // Tokens for buy/sell operations
    const buySellTokens = new Set(['26000', '26009', '26013', '26014', '26037']);
    if (!buySellTokens.has(tk)) {
      //NFO Price update received. Update lp for contract token
      try {
        // Retrieve all contracts
        const contracts = await strapi.db.query('api::contract.contract').findMany();
    
        // Find the contract with the token in either call or put arrays
        const contract = contracts.find(contract => {
          return contract.contractTokens.call.some(call => call.token === tk) ||
                 contract.contractTokens.put.some(put => put.token === tk);
        });
    
        if (contract) {
          // Determine if the token is in CALL or PUT and update lp
          const tokenData = contract.contractTokens.call.find(call => call.token === tk) ||
                            contract.contractTokens.put.find(put => put.token === tk);
    
          if (tokenData) {
            tokenData.lp = lp;
    
            // Update the contract in the database
            await strapi.db.query('api::contract.contract').update({
              where: { id: contract.id },
              data: { contractTokens: contract.contractTokens },
            });
    
            return `Updated lp for token ${tk} in contract ID ${contract.id}`;
          }
        } else {
          return `Token ${tk} not found in any contract.`;
        }
    
      } catch (error) {
        return `Error updating contract token lp: ${error}`;        
      }            
    } else {
        strapi.webSocket.broadcast({
          type: 'index',
          data: feedData,          
          status: true
        })
        const headers = {
            Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Including the special token in the Authorization header
          };  
          const indexItem = await strapi.db.query('api::variable.variable').findOne({
            where: { token: tk },
            headers,
          });
        
          if (!indexItem) {
            return { error: 'Index not found for the provided token' };
          }
        
          // Extract variables of the index
          let {
            basePrice, resistance1, resistance2, support1, support2, targetStep,
            callOptionBought, putOptionBought,callBoughtAt, putBoughtAt, token, index,initialSpectatorMode,previousTradedPrice, amount, quantity
          } = indexItem;
      
          if (basePrice === 0 || resistance1 === 0 || resistance2 === 0 || support1 === 0 || support2 === 0){        
            return { message: `Investment variables not defined for ${index}`};
          }
          

          //Fetch the relevant contract for the given token
          const contract = await strapi.db.query('api::contract.contract').findOne({
            where: { indexToken : token }
          });
          if(!contract){
            return "Some error fetching relevant contracts";
          }
          
          const sessionToken = await strapi.service('api::authentication.authentication').fetchRequestToken();
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
              await strapi.db.query('api::variable.variable').update({
                where: {token: tk},
                data: {initialSpectatorMode},
              });
            } else {
              //LP in Passive zone. No action
              await strapi.db.query('api::variable.variable').update({
                where: {token: tk},
                data: {
                  previousTradedPrice: lp,
                }
              });              
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
              
              strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy CALL at LTP ${lp}`, status: true});
              try{
                //Buy CALL
                callOptionBought = true;
                callBoughtAt = lp;
                previousTradedPrice = lp;
                let updatedVariable = await strapi.db.query('api::variable.variable').update({
                  where: {token : tk},
                  data: {
                    callOptionBought,
                    callBoughtAt,
                    previousTradedPrice,
                  }
                });
                contractType = 'CALL';
                await strapi.service('api::order.order').placeBuyOrder({contractType,lp,contract,sessionToken,amount,quantity});
                return {
                  status: true,
                  message: 'CALL buy Order placed successfully',
                  updatedVariable,
                }
              }catch(error){
                console.log(error);
                return {
                  status: false,
                  message: 'Error placing CALL buy order',
                  error,
                }                
              }            
            } else if(((lp <= basePrice - targetStep && lp > support1 + targetStep) 
              || (lp <= support1 - targetStep && lp > support2 + targetStep)
              || (lp <= support2 - targetStep)
              || (lp <= resistance1 - targetStep && lp > basePrice + targetStep)
              || (lp <= resistance2 - targetStep && lp > resistance1 + targetStep))
              && (previousTradedPrice === 0 || previousTradedPrice > lp)
            ){             
              strapi.webSocket.broadcast({ type: 'variable', message: `Reached Strategic Buy zone for ${index}. Application will attempt to buy PUT at LTP ${lp}`, status: true});
              //Buy PUT 
              try{
                contractType = 'PUT';
                putOptionBought = true;
                putBoughtAt = lp;
                previousTradedPrice = lp;
                let updatedVariable = await strapi.db.query('api::variable.variable').update({
                  where: {token : tk},
                  data: {              
                    putOptionBought,
                    putBoughtAt,
                    previousTradedPrice,
                  }
              });
              await strapi.service('api::order.order').placeBuyOrder({contractType,lp,contract,sessionToken,amount,quantity});
              return {
                status: true,
                message: 'PUT buy Order placed successfully',
                updatedVariable,              
              }
              }catch(error){
                console.log(error);
                return {
                  status: false,
                  message: 'Error placing PUT buy order',
                  error,
                }
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
              try{
                contractType = 'CALL';              
                callOptionBought = false; 
                callBoughtAt = 0;             
                previousTradedPrice = lp;
                let updatedVariable = await strapi.db.query('api::variable.variable').update({
                  where: {token : tk},
                  data: {
                    callOptionBought,                  
                    previousTradedPrice,
                    callBoughtAt,
                  }
                });
                await strapi.service('api::order.order').placeSellOrder({contractType,lp,contract,sessionToken,index});
                return {
                  status: true,
                  message: 'CALL sell Order placed successfully',
                  updatedVariable,              
                }
              }catch(error){
                console.log(error);
                return {
                  status: false,
                  message: 'Error placing CALL sell order',
                  error,
                }
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
              try{
                contractType = 'PUT';             
                putOptionBought = false;  
                putBoughtAt = 0;            
                previousTradedPrice = lp;
                let updatedVariable = await strapi.db.query('api::variable.variable').update({
                  where: {token: tk},
                  data: {
                    putOptionBought,                  
                    previousTradedPrice,
                    putBoughtAt
                  }           
                });
                await strapi.service('api::order.order').placeSellOrder({contractType,lp,contract,sessionToken,index});
                return {
                  status: true,
                  message: 'PUT sell Order placed successfully',
                  updatedVariable,
                }
              }catch(error){
                console.log(error);
                return {
                  status: false,
                  message: 'Error placing PUT sell order',
                  error,
                }
              }             
                            
            }
          }         
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
      };

      const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`,
      };

      // Fetch all entries in the variable collection
      const variableEntries = await strapi.entityService.findMany('api::variable.variable', {
        headers,
        fields: ['id'],
      });

      // Iterate over each entry and update it with default values
      for (const entry of variableEntries) {
        await strapi.entityService.update('api::variable.variable', entry.id, {
          data: defaultValues,
        });
      }
      strapi.webSocket.broadcast({ type: 'action',message: "Investment variables reset", status: true, });
         
    } catch (error) {
      strapi.webSocket.broadcast({ type: 'action',message: "Error resetting investment variables. Please reset all variables", status: false, });
        
    }
  },

  //Cron function to stop market at 3.15pm daily
  async stopTrading() {
    try {
      const defaultValues = {
        basePrice: 0,
        resistance1: 0,
        resistance2: 0,
        support1: 0,
        support2: 0,
        amount: 0,
        quantity: 0,                        
      };

      const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`,
      };

      // Fetch all entries in the variable collection
      const variableEntries = await strapi.entityService.findMany('api::variable.variable', {
        headers,
        fields: ['id'],
      });

      // Iterate over each entry and update it with default values
      for (const entry of variableEntries) {
        await strapi.entityService.update('api::variable.variable', entry.id, {
          data: defaultValues,
        });
      }    
      
      strapi.webSocket.broadcast({type: 'action', message: 'Application is stopped now.Please sell all positions before starting to trade again.', status: true});
      return {status: true, message: 'Application stopped now..'};
    } catch (error) {
      console.error("Error resetting investment variables:", error);      
      strapi.webSocket.broadcast({ type: 'action',message: `Error stopping the applcation with error: ${error}`, status: false });      
      return {status: false, message: `Error stopping the applcation with error: ${error}`};
    }
  },
  
}));

