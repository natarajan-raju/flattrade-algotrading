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
          quantity
        } = ctx.request.body;        
        if (!quantity || !expiry || !amount || !indexToken || indexToken.length === 0 || !basePrice || !resistance1 || !resistance2 || !support1 || !support2) {
            return ctx.send({ message: 'Invalid Payload provided. Please fill all the fields...', status: false, });
        } else if(quantity <= 0 || amount <= 0 || basePrice <=0 || resistance1 <=0 || resistance2 <=0 || support1 <=0 || support2 <=0){
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
            if(!contracts.values || contracts.values.length == 0 ){
                return ctx.send({ message: contracts.emsg ||'Either expiry data provided is wrong or Session token expired', status: false });
            }
        } catch (error) {
            return ctx.send({ message: 'Either expiry data provided is wrong or Session token expired', status: false });
        }        
       
        //Fetch and create previousTradedPrice which is beneficial for initialSpectatorMode decisions
        let previousTradedPrice;
        try{
            const payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","exch":"NSE","token":"${strapi.sessionToken}"}&jKey=${strapi.sessionToken}`;
            const quoteReponse = await fetch(`${env('FLATTRADE_GET_QUOTES_URL')}`,{
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: payload, 
            });
            const quote = await quoteReponse.json();                        
            previousTradedPrice = quote.lp || 0;
            
        }catch(error){
            return ctx.send({ message: `Error in fetching LTP of the index from Flattrade with error:  ${error}`, status: false });            
        }

              
        // Step 2: Update values for the found index
        const updatedIndexItem = await strapi.db.query('api::variable.variable').update({
            where: { indexToken },  
            data: {
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
            previousTradedPrice,
            callBoughtAt: 0,
            putBoughtAt: 0,
            awaitingOrderConfirmation: false,
            },
        });
        strapi[`${indexToken}`] = new Map(Object.entries(updatedIndexItem));
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
       
        await strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket(scripList);
        
        
   
                
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
    }   
}));

