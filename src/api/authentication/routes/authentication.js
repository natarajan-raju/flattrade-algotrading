'use strict';

module.exports = {
  routes: [
    {
        method: 'GET',
        path: '/authentications/handleRequestToken',
        handler: 'api::authentication.authentication.handleRequestToken', // Your custom token handling logic
        config: {
          policies: [],
          middlewares: [],
        },
    },    
    {
      method: 'GET',
      path: '/authentications/undefined',
      handler: 'api::authentication.authentication.handleUndefinedRoute', // Your custom token handling logic
      config: {
        policies: [],
        middlewares: [],
      },
  },
    {
      method: 'GET',
      path: '/authentications',
      handler: 'api::authentication.authentication.find', 
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'GET',
      path: '/authentications/:id',
      handler: 'api::authentication.authentication.findOne',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'POST',
      path: '/authentications',
      handler: 'api::authentication.authentication.create',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'PUT',
      path: '/authentications/:id',
      handler: 'api::authentication.authentication.update',
      config: {
        policies: [],
        middlewares: [],
      },
    },
    {
      method: 'DELETE',
      path: '/authentications/:id',
      handler: 'api::authentication.authentication.delete',
      config: {
        policies: [],
        middlewares: [],
      },
    },
   
   
  ],
};
