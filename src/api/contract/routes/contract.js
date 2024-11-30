'use strict';

/**
 * contract router
 */

// @ts-ignore
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::contract.contract');
