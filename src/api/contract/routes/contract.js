'use strict';

/**
 * contract router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::contract.contract');
