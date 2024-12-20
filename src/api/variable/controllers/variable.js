'use strict';
const { env } = require('@strapi/utils');


/**
 * variable controller
 */

// @ts-ignore
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::variable.variable', ({ strapi }) => ({
    //Handle Update request
    async handleInvestmentVariables(ctx) {        
        const userId = env('FLATTRADE_USER_ID');
        const accountId = env('FLATTRADE_ACCOUNT_ID');
        const requestTokenResponse = await strapi.service('api::authentication.authentication').fetchRequestToken();
        if(!requestTokenResponse.requestToken){
            return ctx.send({ message: 'Request token not found', status: false });
        }
        const sessionToken = requestTokenResponse.requestToken;
        
        const {
          basePrice,          
          resistance1,
          resistance2,
          support1,
          support2,
          token,
          amount,
          expiry,
          quantity
        } = ctx.request.body;
    
        const index = await strapi.db.query('api::variable.variable').findOne({
            where: { token },  // Filter by token
        });       
        
        if (!index || !quantity || !expiry || !amount || !token || !basePrice || !resistance1 || !resistance2 || !support1 || !support2) {
            return ctx.send({ message: 'Either Index not found for the provided token or invalid payload provided', status: false, });
        }

        if(quantity <= 0 || amount <= 0){
            return ctx.send({ message: 'Invalid amount or quantity', status: false });
        }
        
        let existingContract;
        let scripList = 'NSE|26000#NSE|26009#NSE|26013#NSE|26037#NSE|26014#';
        try{
            let payload = `jData={"uid":"${env('FLATTRADE_USER_ID')}","stext":"${index.index+convertDateFormat(expiry)}","exch":"NFO"}&jKey=${sessionToken}`;
            
            const contractsResponse = await fetch(`${env('FLATTRADE_SEARCH_SCRIP_URL')}`,{
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: payload, 
            });
            const contracts = await contractsResponse.json();  
             
                      
            if(contracts.values && contracts.values.length > 0 ){                         
                existingContract = await strapi.db.query('api::contract.contract').findOne(
                    {
                        where: {
                            index: index.index,
                        }
                    }
                );                
                if(!existingContract){
                    existingContract =await strapi.db.query('api::contract.contract').create({
                        data:{
                            sampleContractTsym: contracts.values[0].tsym,
                            index: index.index,
                            indexToken: index.token,                            
                        },
                    });
                }
                
                
               //Generate Option chain for the sample contract
                const optionChainResponse = await strapi.service('api::variable.variable').processOptionChain(existingContract.sampleContractTsym,sessionToken);     
                
                if(!optionChainResponse.status){
                    return {"updatedData": null, status: false, "message":optionChainResponse.message};
                } else {
                    // Destructure contractTokens from the response
                    const { contractTokens } = optionChainResponse;

                    // Prepare the scripList string for WebSocket subscription
                    scripList += [
                        ...contractTokens.call.map(tokenObj => `NFO|${tokenObj.token}`),
                        ...contractTokens.put.map(tokenObj => `NFO|${tokenObj.token}`)
                    ].join('#');

                    
                } 
                 
            } else {
                return {"status": false, "updatedData": null, "message": "Either the expiry data provided is wrong or there is some error fetching relevant scrips. Please try again with proper data"};
            }
                         
            
        }catch(error){
            return {
                message: error,                
                updatedIndex: null,
                status: false,
            }
        }
        

       
        //Retrieve relevant contracts with the given expiry dates
           
        
        // Step 2: Update values for the found index
        const updatedIndex = await strapi.db.query('api::variable.variable').update({
            where: { id: index.id },  // Update based on index ID
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
            previousTradedPrice: 0,
            },
        });
        
                
        // Step 3: Connect to Flattrade WebSocket        
        await strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket(userId, sessionToken, accountId, scripList);
        return {
            message: "Investment variables updated successfully. Market watching started.",
            status: true,
            updatedIndex,            
        }
    },

    //Stop Trading
    async stopTrading(ctx) {
        const { token } = ctx.request.body;   
        return ctx.send(await strapi.service('api::variable.variable').stopTrading(token));
    }   
}));

//Local function to convert date to string for Scrip search

function convertDateFormat(inputDate) {
    const dateParts = inputDate.split('-'); // Split YYYY-MM-DD into [YYY,MM,DD]
    const [year, month, day] = dateParts;
    
    const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const monthIndex = parseInt(month, 10) - 1; // Convert month from 1-based to 0-based index
    
    const formattedDate = `${day}${monthNames[monthIndex]}${year.toString().slice(-2)}C`;
    return formattedDate;    
}
