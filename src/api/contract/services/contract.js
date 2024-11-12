'use strict';

/**
 * contract service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::contract.contract');
