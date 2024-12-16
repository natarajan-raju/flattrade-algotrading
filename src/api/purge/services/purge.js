'use strict';

/**
 * purge service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::purge.purge',({ strapi }) => ({
    //Purge orders prior to 3 days from the current date
    async purgeOrders() {
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const orders = await strapi.db.query('api::order.order').findMany({
            where: {
                createdAt: {
                    lte: threeDaysAgo,
                }
            }
        });
        if(orders.length === 0){
            strapi.log.info('No orders to purge...');
            return;
        }
        //Loop through each order, create a new purgedOrder and delete it
        for (const order of orders) {
            const purgedOrder = await strapi.db.query('api::purgedorder.purgedorder').create({ data: order });
            //update orderDate field in ourgedOrder with the createdAt field in the order
            await strapi.db.query('api::purgedorder.purgedorder').update({ where: { id: purgedOrder.id }, data: { orderDate: order.createdAt } });
            await strapi.db.query('api::order.order').delete({ where: { id: order.id } });
        }
        console.log(`${orders.length} orders purged upto ${threeDaysAgo}.`);
    },
}
));
