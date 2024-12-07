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


}));
