'use strict';

/**
 * purge controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::purge.purge');
