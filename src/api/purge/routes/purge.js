'use strict';

/**
 * purge router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::purge.purge');
