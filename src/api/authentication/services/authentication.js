// @ts-nocheck
'use strict';

const { env } = require('@strapi/utils');
// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::authentication.authentication', ({ strapi }) => ({
  
  
  async fetchRequestToken() {
    
      const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Use the special token in the Authorization header
      };

      // Retrieve all tokens (without any conditions)
      const existingTokens = await strapi.db.query('api::authentication.authentication').findMany({
        headers,
      });

      // Return the first token found or default values if none exist
      strapi.sessionToken = existingTokens[0]?.requestToken || null;
      return {
        requestToken: existingTokens[0]?.requestToken || false,
        id: existingTokens[0]?.id || "",
      };    
  },

  // Other authentication-related service functions can go here

}));
