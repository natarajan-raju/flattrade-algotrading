'use strict';

/**
 * variable router
 */

// @ts-ignore
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = {
    routes: [
        {
          method: 'POST',
          path: '/variables/startAmountBasedTrading',
          handler: 'api::variable.variable.startAmountBasedTrading', // Your custom token handling logic
          config: {
            policies: [],
            middlewares: [],
          },
      },
        {
            method: 'POST',
            path: '/variables/handleInvestmentVariables',
            handler: 'api::variable.variable.handleInvestmentVariables', // Your custom token handling logic
            config: {
              policies: [],
              middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/variables/stopTrading',
            handler: 'api::variable.variable.stopTrading', // Your custom token handling logic
            config: {
              policies: [],
              middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/variables/getTimePriceData',
            handler: 'api::variable.variable.getTimePriceData', // Your custom token handling logic
            config: {
              policies: [],
              middlewares: [],
            },
        },      

        {
            method: 'GET',
            path: '/variables',
            handler: 'api::variable.variable.find', 
            config: {
              policies: [],
              middlewares: [],
            },
        },
        {
            method: 'GET',
            path: '/variables/:id',
            handler: 'api::variable.variable.findOne',
            config: {
              policies: [],
              middlewares: [],
            },
        },          
        {
            method: 'PUT',
            path: '/variables/:id',
            handler: 'api::variable.variable.update',
            config: {
              policies: [],
              middlewares: [],
            },
        },        
    ],
};
