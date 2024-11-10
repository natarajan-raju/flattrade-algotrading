'use strict';

/**
 * web-socket router
 */

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::web-socket.web-socket');
