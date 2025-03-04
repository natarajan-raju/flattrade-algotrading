'use strict';

/**
 * profit service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::profit.profit',({ strapi }) => ({
    async calculateProfits(){
        console.log('Profits being calculated');
        try{        
        const profits = await strapi.db.query('api::profit.profit').findMany({
            where: {
                realizedPL: { $gt: 0 }
            }
        });
        // console.log(profits);
        for (const profit of profits){
            // const realizedPL = profit.realizedPL            
            profit.totalPL = profit.totalPL || 0 + profit.realizedPL || 0;
            profit.totalInvested = profit.invested || 0 + profit.totalInvested || 0;
            profit.totalSold = profit.sold || 0 + profit.totalSold || 0;
            profit.totalReturnPercentage = (profit.totalPL / profit.totalInvested) * 100;
            const profitItem = await strapi.db.query('api::profit.profit').update({ where: { indexToken: profit.indexToken }, data: { totalPL: profit.totalPL, totalInvested: profit.totalInvested, totalSold: profit.totalSold, totalReturnPercentage: profit.totalReturnPercentage, realizedPL: 0, invested: 0, sold: 0, returnPercentage: 0 } });           
            
            // console.table(profitItem);
        }
    }
        catch(e){
            console.log(e);
    }
        console.log('Profits calculated upto date...')
    }
}));
