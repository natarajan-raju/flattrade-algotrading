'use strict';

/**
 * order controller
 */

// @ts-ignore
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::order.order', ({strapi}) => ({
    //Place Sell order custom function
    async placeSellOrder(ctx){
        const { contractType, lp, index, indexToken, quantity } = ctx.request.body;
        
        if( !contractType || !lp || !index || !indexToken || !quantity){
            return ctx.send('Invalid payload provided');
        }
        const orderResponse = await strapi.service('api::order.order').placeSellOrder({contractType, lp, index, indexToken, quantity });
        if(orderResponse.status){
            return ctx.send("Order placed successfully");
        } else {
            return ctx.badRequest('No positions found to sell..');
        }
    }
}));
