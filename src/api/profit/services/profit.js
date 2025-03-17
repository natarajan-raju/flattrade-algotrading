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
            profit.totalPL = profit.totalPL + profit.realizedPL;
            profit.totalInvested = profit.invested + profit.totalInvested;
            profit.totalSold = profit.sold + profit.totalSold ;
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
