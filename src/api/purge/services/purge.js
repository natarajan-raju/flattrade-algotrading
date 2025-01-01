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
        // uptoDate.setDate(uptoDate.getDate() - 1);
        let formattedDate = uptoDate.toISOString().split('T')[0];
        const orders = await strapi.db.query('api::order.order').findMany();
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

    //Delete purged orders once in a month
    async deletePurgeTableMonthly() {
        let uptoDate = new Date();
        let formattedDate = uptoDate.toISOString().split('T')[0];
        
        // Calculate the date 1 month ago from the current date
        let oneMonthAgo = new Date(uptoDate);
        oneMonthAgo.setMonth(uptoDate.getMonth() - 1);
        
        // Find all records in the 'purge' table older than or equal to 1 month
        const oldPurgedRecords = await strapi.db.query('api::purge.purge').findMany({
            where: {
                createdAt: {
                    $lte: oneMonthAgo // records created on or before one month ago
                }
            }
        });
    
        if(oldPurgedRecords.length === 0){
            strapi.log.info('No data older than 1 month to purge...');
            strapi.webSocket.broadcast({ type: 'action', message: `No data older than 1 month to purge from the purge table for ${formattedDate}.`, status: false });
            return;
        }
    
        // Deleting purged records older than or equal to 1 month
        await strapi.db.query('api::purge.purge').deleteMany({
            where: {
                createdAt: {
                    $lte: oneMonthAgo // records created on or before one month ago
                }
            }
        });
    
        // Log and broadcast the purge operation
        strapi.webSocket.broadcast({ type: 'action', message: `${oldPurgedRecords.length} records purged from the purge table for ${formattedDate}.`, status: true });
        strapi.log.info(`${oldPurgedRecords.length} records purged from the purge table for ${formattedDate}.`);
    },
    
    
}
));
