'use strict';

/**
 * variable service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::variable.variable');
