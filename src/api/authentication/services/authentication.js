'use strict';

/**
 * authentication service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::authentication.authentication');
