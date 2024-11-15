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
  async processOptionChain(sampleContractTsym,sessionToken){
    try{
      const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","tsym":"${sampleContractTsym}","exch":"NFO","strprc":"${sampleContractTsym.slice(-5)}","cnt":"500"}&jKey=${sessionToken}`;
      const optionChainResponse = await fetch(`${env('FLATTRADE_OPTION_CHAIN_URL')}`,{
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
                  },
        body: payload,
        });
        const optionChain = await optionChainResponse.json();
        const contracts = {
          call: [],
          put: [],
        };
        optionChain.values.forEach(option => {
          if (option.optt === 'CE') {
            contracts.call.push(option.tsym);
          } else if (option.optt === 'PE') {
            contracts.put.push(option.tsym);
          }
        });
        console.log(contracts);
        await strapi.db.query('api::contract.contract').update({
          where: { sampleContractTsym },
          data: {
            symbols: contracts,
          },
        });
        return { message: 'Option chain processed successfully',status: true };
    }catch(error){
      return { message: error, status: false }
    }  
      
  },

  //Custom service function to handle trade logic basis Flattrade touchline feed
  async handleFeed(feedData) {
    
    const { lp, tk } = feedData;
    if(!lp){
      return { message: 'Not a LTP message' };
    }   
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
      callOptionBought, putOptionBought,callBoughtAt, putBoughtAt, index,initialSpectatorMode,previousTradedPrice
    } = indexItem;

    if (basePrice === 0 || resistance1 === 0 || resistance2 === 0 || support1 === 0 || support2 === 0){        
      return { message: `Investment variables not defined for ${index}`};
    }
    // Initialize a message collection
    let message = '';

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
        message = `No actions taken at LTP ${lp}`;
        message += '\n';
        fs.appendFile('D:/output.txt',message,(err) => {
          if(err) throw err;
            console.log('Data written to output.txt');
        });
        return {message};
      }
    }
    
    let orderType;
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
        message = `Buying call at ${lp}.`;
        console.log(message);
        message += '\n';
        fs.appendFile('D:/output.txt',message,(err) => {
          if(err) throw err;
          console.log('Data written to output.txt');
        });

        //call buy Flattrade API code here

        orderType = 'BUY';
        contractType = 'CALL';
        const createdOrder = await strapi.service('api::order.order').placeOrder({orderType,contractType,index,lp});
        
        callOptionBought = true;
        callBoughtAt = lp;
        previousTradedPrice = lp;
        const updatedVariable = await strapi.db.query('api::variable.variable').update({
          where: {token : tk},
          data: {
            callOptionBought,
            callBoughtAt,
            previousTradedPrice,
          }
        });
        return {
          message,
          createdOrder,
          updatedVariable
        };
      } else if(((lp <= basePrice - targetStep && lp > support1 + targetStep) 
        || (lp <= support1 - targetStep && lp > support2 + targetStep)
        || (lp <= support2 - targetStep)
        || (lp <= resistance1 - targetStep && lp > basePrice + targetStep)
        || (lp <= resistance2 - targetStep && lp > resistance1 + targetStep))
        && (previousTradedPrice === 0 || previousTradedPrice > lp)
      ){
        message = `Buying PUT at ${lp}`;
        console.log(message);
        message += '\n';
        fs.appendFile('D:/output.txt',message,(err) => {
          if(err) throw err;
          console.log('Data written to output.txt');
        });
        //PUT buy API
        orderType = 'BUY';
        contractType = 'PUT'
        const createdOrder = await strapi.service('api::order.order').placeOrder({orderType,contractType,index,lp});
        putOptionBought = true;
        putBoughtAt = lp;
        previousTradedPrice = lp;
        const updatedVariable = await strapi.db.query('api::variable.variable').update({
          where: {token : tk},
          data: {              
            putOptionBought,
            putBoughtAt,
            previousTradedPrice,
          }
        });
        return{
          message,
          createdOrder,
          updatedVariable
        };
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
        message=`Selling CALL: Bought at ${callBoughtAt} Sold at ${lp}`;
        console.log(message);
        message += '\n';
        fs.appendFile('D:/output.txt',message,(err) => {
          if(err) throw err;
          console.log('Data written to output.txt');
        });
        //call sell API
        orderType = 'SELL';
        contractType = 'CALL'
        const createdOrder = await strapi.service('api::order.order').placeOrder({orderType,contractType,index,lp});
        callOptionBought = false;
        callBoughtAt = 0;
        previousTradedPrice = lp;
        const updatedVariable = await strapi.db.query('api::variable.variable').update({
          where: {token : tk},
          data: {
            callOptionBought,
            callBoughtAt,
            previousTradedPrice,
          }
        });
        return {
          message,
          createdOrder,
          updatedVariable
        };          
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
        message = `Selling PUT: Bought at ${putBoughtAt} Sold at ${lp}`;
        console.log(message);
        message += '\n';
        fs.appendFile('D:/output.txt',message,(err) => {
          if(err) throw err;
          console.log('Data written to output.txt');
        });
        //PUT sell API
        orderType = 'SELL';
        contractType = 'PUT'
        const createdOrder = await strapi.service('api::order.order').placeOrder({orderType,contractType,index,lp});
        putOptionBought = false;
        putBoughtAt = 0;
        previousTradedPrice = lp;
        const updatedVariable = await strapi.db.query('api::variable.variable').update({
          where: {token: tk},
          data: {
            putOptionBought,
            putBoughtAt,
            previousTradedPrice,
          }           
        });
        return {
          message,
          createdOrder,
          updatedVariable
        };
      }
    }

    message = `No actions taken at LTP ${lp}`;
    message += '\n';
    await strapi.db.query('api::variable.variable').update({
      where: {token: tk},
      data: {
        previousTradedPrice: lp,
      }
    });
    fs.appendFile('D:/output.txt',message,(err) => {
      if(err) throw err;
      console.log('Data written to output.txt');
    });      
    return {message};
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
        putBoughtAt: 0
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

      console.log("All investment variables have been reset to default values.");
    } catch (error) {
      console.error("Error resetting investment variables:", error);
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

      console.log("Investment variables reset for Market Stop");
    } catch (error) {
      console.error("Error resetting investment variables:", error);
    }
  },
  
}));

