'use strict';

/**
 * contract controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::contract.contract');
