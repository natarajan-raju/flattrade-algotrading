'use strict';

/**
 * web-socket controller
 */

// @ts-ignore
const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::web-socket.web-socket');
