'use strict';

/**
 * web-socket router
 */

// @ts-ignore
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::web-socket.web-socket');
