'use strict';

const WebSocket = require('ws');

module.exports = {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/*{ strapi }*/) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }) {
    
    // Initialize WebSocket server     
    const setFoundation = async () => {      
      await strapi.service('api::web-socket.web-socket').initializeWebSocketServer();      
      await strapi.service('api::variable.variable').fetchIndexVariables();
      strapi.INDICES = ['26000','26009','26013','26014','26037'];  
      strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket();
      
    };
    setFoundation().then((result) => {
      console.log('WebSocket server initialized & Index Variables Fetched succesfully');     
      
    }).catch((error) => {
      console.error('Either WebSocket server initialization failed or Fetching Index Variables failed :', error);
    });
  },
};
