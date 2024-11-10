'use strict';
const { env } = require('@strapi/utils');

/**
 * variable service
 */

// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::variable.variable', ({ strapi }) => ({
  // Custom function to reset investment variables
  async resetInvestmentVariables() {
    try {
      const defaultValues = {
        basePrice: 0,
        resistance1: 0,
        resistance2: 0,
        support1: 0,
        support2: 0,
        amount: 0,
        previousTradedPrice: 0,
        initialSpectatorMode: true,
        callOptionBought: false,
        putOptionBought: false,
        callBoughtAt: 0,
        putBoughtAt: 0
      };
      const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Including the special token in the Authorization header
    };
      // Update the variable entries with default values
      await strapi.entityService.update('api::variable.variable',
        headers,
        { data: defaultValues });

      console.log("Investment variables reset to default values.");
    } catch (error) {
      console.error("Error resetting investment variables:", error);
    }
  },
}));

