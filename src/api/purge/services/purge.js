'use strict';

/**
 * purge service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::purge.purge',({ strapi }) => ({
    //Purge orders prior to 3 days from the current date
    async purgeOrders() {
        let uptoDate = new Date();
        uptoDate.setDate(uptoDate.getDate() - 1);
        let formattedDate = uptoDate.toISOString().split('T')[0];
        const orders = await strapi.db.query('api::order.order').findMany({
            where: {
                createdAt: {
                    $lte: formattedDate,
                }
            }
        });
        if(orders.length === 0){
            strapi.log.info('No orders to purge...');
            strapi.webSocket.broadcast({ type: 'action', message: `No orders to purge upto ${formattedDate}.`, status: false });
            return;
        }
        //Loop through each order, create a new purgedOrder and delete it
        for (const order of orders) {
            const purgedOrder = await strapi.db.query('api::purge.purge').create({ data: order });
            //update orderDate field in ourgedOrder with the createdAt field in the order
            await strapi.db.query('api::purge.purge').update({ where: { id: purgedOrder.id }, data: { orderDate: order.createdAt } });
            await strapi.db.query('api::order.order').delete({ where: { id: order.id } });
        }
        strapi.webSocket.broadcast({ type: 'action', message: `${orders.length} orders purged upto ${formattedDate}.`, status: true });
        strapi.log.info(`${orders.length} orders purged upto ${formattedDate}.`);
    },
}
));
