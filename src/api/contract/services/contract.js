'use strict';

/**
 * contract service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::contract.contract', ({ strapi }) => ({
    //Clear contract variables
    async clearContractVariables() {
        await strapi.db.query('api::contract.contract').deleteMany({});
        console.log('Contract variables cleared');
    },

    async getLpForOptionToken(token, index){
        const contract = await strapi.db.query('api::contract.contract').findOne({
            where: { index },
        });
        if(!contract){
            return {
                status: false,
                message: 'Contract not found',
            }
        };
        const { contractTokens } = contract;
        if(!contractTokens){
            return {
                status: false,
                message: 'Contract token not found',
            }
        };
        // Search for the token in the "call" array
        const callToken = contractTokens.call.find((item) => item.token === token);
        if (callToken) {
            return callToken.lp; // Return the lp if token is found in call array
        }

        // Search for the token in the "put" array
        const putToken = contractTokens.put.find((item) => item.token === token);
        if (putToken) {
            return putToken.lp; // Return the lp if token is found in put array
        }

        // Token not found in either array
        return {
            status: false,
            message: `Token: ${token} not found in contractTokens for index: ${index}`,
        }        
    },

}));
