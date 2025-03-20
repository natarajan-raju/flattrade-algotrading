'use strict';

/**
 * position router
 */

// @ts-ignore
const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = {
    routes: [
        {
            method: 'GET',
            path: '/positions',
            handler: 'api::position.position.find', 
            config: {
              policies: [],
              middlewares: [],
            },
          },
          {
            method: 'GET',
            path: '/positions/:id',
            handler: 'api::position.position.findOne',
            config: {
              policies: [],
              middlewares: [],
            },
          },
          {
            method: 'POST',
            path: '/positions',
            handler: 'api::position.position.create',
            config: {
              policies: [],
              middlewares: [],
            },
          },
          {
            method: 'PUT',
            path: '/positions/:id',
            handler: 'api::position.position.update',
            config: {
              policies: [],
              middlewares: [],
            },
          },
          {
            method: 'DELETE',
            path: '/positions/:id',
            handler: 'api::position.position.delete',
            config: {
              policies: [],
              middlewares: [],
            },
          },         
    ]
}
