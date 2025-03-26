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
          console.log("Amount-based trading initiated with:", { entry, target, stopLoss, indexToken, expiry });  
       
          const indexItem =await strapi.db.query('api::variable.variable').findOne({where: {indexToken}});
          const index = indexItem.index;
          if(indexItem.basePrice === 0 && strapi.amountTradingCounter === 0){
                strapi.log.info(`It seems Index based trading has not been started for ${index}. Hence trying to retrieve options data for ${index}`);
                if ((strapi[`${indexToken}`]?.size ?? 0) === 0) {
                    strapi[`${indexToken}`] = new Map(Object.entries(indexItem));
                }
                
                strapi[`${indexToken}`].set('index', index);          
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
                        console.log(scripList); 
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
            }
          strapi.service('api::variable.variable').startAmountMonitoring(index, entry, target, stopLoss);
          strapi.amountTradingCounter++;
          return ctx.send({ message: 'Amount based trading started successfully', status: true });
    
          
        } catch (error) {
          console.error("Error in startAmountBasedTrading:", error);
          return ctx.badRequest("Trading failed due to an internal error.");
        }
      },
    
}));

