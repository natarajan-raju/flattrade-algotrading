'use strict';
const { env } = require('@strapi/utils');
const { connectFlattradeWebSocket } = require('../../../../config/functions/websocketClient.js');
const { fetchRequestToken } = require('../../../../config/functions/fetchRequestToken.js');
const fs = require( 'fs' );
/**
 * variable controller
 */

// @ts-ignore
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::variable.variable', ({ strapi }) => ({
    //Handle Update request
    async handleInvestmentVariables(ctx) {        
        const userId = env('FLATTRADE_USER_ID');
        const requestTokenResponse = await fetchRequestToken()
                          .then((data) => {return {
                            requestToken: data.requestToken,
                            id: data.id
                            }
                          })
                          .catch((err) => {
                            console.log({err});
                            return {
                              requestToken: false,
                              id: '',
                            };
                          });;
        if(!requestTokenResponse.requestToken){
            return ctx.send({ error: 'Request token not found' });
        }
        const sessionToken = requestTokenResponse.requestToken;
        const accountId = env('FLATTRADE_ACCOUNT_ID');
        const {
          basePrice,          
          resistance1,
          resistance2,
          support1,
          support2,
          token,
          amount
        } = ctx.request.body;
    
        const index = await strapi.db.query('api::variable.variable').findOne({
            where: { token },  // Filter by token
        });
        
        if (!index) {
            return ctx.send({ error: 'Index not found for the provided token' });
        }

        // Step 2: Update values for the found index
        const updatedIndex = await strapi.db.query('api::variable.variable').update({
            where: { id: index.id },  // Update based on index ID
            data: {
            basePrice,
            resistance1,
            resistance2,
            support1,
            support2,
            amount, // Store the investment amount
            lastTradedPrice: 0,
            initialSpectatorMode: true,
            previousTradedPrice: 0,
            },
        });
        
        // Step 3: Connect to Flattrade WebSocket        
        connectFlattradeWebSocket(userId, sessionToken, accountId);
        return {
            message: "Investment variables updated successfully",
            updatedIndex,
        }
    },
    //handle touchline live feed
    async handleFeed(ctx) {
      const data = JSON.parse( ctx.request.body ); 
      // Fetch the investment variables and current states for the index token tk
      const { feedData: {lp, tk} } = data;
      if(!lp){
        return ctx.send({ message: 'Not a LTP message' });
      }   
      const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Including the special token in the Authorization header
      };  
      const indexItem = await strapi.db.query('api::variable.variable').findOne({
        where: { token: tk },
      });
    
      if (!indexItem) {
        return ctx.send({ error: 'Index not found for the provided token' });
      }
    
      // Extract variables of the index
      let {
        basePrice, resistance1, resistance2, support1, support2, targetStep,
        callOptionBought, putOptionBought,callBoughtAt, putBoughtAt, index,initialSpectatorMode,previousTradedPrice
      } = indexItem;

      if (basePrice === 0 || resistance1 === 0 || resistance2 === 0 || support1 === 0 || support2 === 0){        
        return ctx.send({ message: `Investment variables not defined for ${index}`});
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
          return ctx.send({message});
        }
      }
    
      
      

      const uid = env('FLATTRADE_USER_ID');
          const actid = env('FLATTRADE_ACCOUNT_ID');
          const exch = 'NFO';
          let tysm = '';
          const qty = 15;
          const prc = 1500;
          const prd = 'M';
          let trantype;
          const prctyp = 'MKT';
          const ordersource = 'API';
          const ret = "DAY";
      
      
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
          //call API

          trantype = 'BUY';
          tysm = 'CALLBUY'
          const createdOrder = await strapi.db.query('api::order.order').create({
            headers,
            data: {
              uid,
              actid,
              exch,
              tysm,
              qty,
              prc,
              prd,
              trantype,
              prctyp,
              ret,
            }            
          });
          console.log(createdOrder);
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
          return ctx.send({
            message,
            createdOrder,
            updatedVariable
          });
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
          trantype = 'BUY';
          tysm = 'PUTBUY'
          const createdOrder = await strapi.db.query('api::order.order').create({
            data: {
              uid,
              actid,
              exch,
              tysm,
              qty,
              prc,
              prd,
              trantype,
              prctyp,
              ret,
            }            
          });
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
          return ctx.send({
            message,
            createdOrder,
            updatedVariable
          });
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
          trantype = 'SELL';
          tysm = 'CALLSELL'
          const createdOrder = await strapi.db.query('api::order.order').create({
            data: {
              uid,
              actid,
              exch,
              tysm,
              qty,
              prc,
              prd,
              trantype,
              prctyp,
              ret,
            }
          });
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
          return ctx.send({
            message,
            createdOrder,
            updatedVariable
          });          
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
          trantype = 'SELL';
          tysm = 'PUTSELL'
          const createdOrder = await strapi.db.query('api::order.order').create({
            data: {
              uid,
              actid,
              exch,
              tysm,
              qty,
              prc,
              prd,
              trantype,
              prctyp,
              ret,
            }
          });
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
          return ctx.send({
            message,
            createdOrder,
            updatedVariable
          });
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
      return ctx.send({message});
    }, 
    
}));

