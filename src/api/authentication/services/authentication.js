// @ts-nocheck
'use strict';

const { env } = require('@strapi/utils');
const { ExecutionContext } = require('styled-components');
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

  async clearAuthentications(){
    const existingTokens = await strapi.db.query('api::authentication.authentication').findMany();
    console.log(`Existing Tokens: ${existingTokens}`)
    const documentId = existingTokens[0].documentId;
    strapi.db.query('api::authentication.authentication').update(
      {
        where: {documentId},
        data: {
          requestToken: '',
        }
      }
    );
    strapi.sessionToken = null;
    console.log('Authentications cleared for the day....');
  }

  // Other authentication-related service functions can go here

}));
