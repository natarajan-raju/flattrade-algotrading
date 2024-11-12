'use strict';

/**
 * order service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({
    //Place Order service
    async placeOrder(orderData) {
        let { orderType, contractType, index, lp} = orderData;        
        const createdOrder = await strapi.db.query('api::order.order').create({
            data: {
                orderType,
                contractType,
                index,
                boughtAtLtp: lp,
            }
        });
        return createdOrder;
    },

}));
