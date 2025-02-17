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
      // // strapi.rollingData = {};
      // // Simulate market
      // // Simulate market with gradual price changes
      // // Simulate market with gradual price changes and 1-second delay
      // strapi['2000'] = new Map();
      // strapi['2000'].set('optt','CE');

      // let lastPrice = 25; // Initial price

      // const generateFeedObject = () => {
      //   // Generate a small random step change (-0.5 to +0.5)
      //   const priceChange = (Math.random() - 0.5) * 1; 
      //   lastPrice = Math.max(10, lastPrice + priceChange); // Ensure price doesn't drop below 10

      //   return {
      //     t: 'tf',
      //     e: 'NFO', 
      //     tk: '2000', // Random token
      //     lp: lastPrice.toFixed(2), // Updated last price
      //   };
      // };

      // const variableService = strapi.service('api::variable.variable');

      // const sendFeeds = async () => {
      //   for (let i = 0; i < 30; i++) {
      //     const feed = generateFeedObject();

      //     try {
      //       variableService.handleFeed(feed);
      //       console.log(`Sent feed ${i + 1}:`, feed);
      //     } catch (error) {
      //       console.error(`Error processing feed: ${error.message}`);
      //     }

      //     await new Promise(resolve => setTimeout(resolve, 1000)); // 1-second delay
      //   }
      // };

      // sendFeeds();


      strapi.INDICES = ['26000','26009','26013','26014','26037'];
      // strapi.webSocket.broadcast({ type: 'action', message: 'Application is restarted. Please submit values to begin trading...', status: true });  
      // strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket()
      const currentTime = new Date();
      const currentHour = currentTime.getHours();
      const currentMinute = currentTime.getMinutes();
      if(currentHour < 9 
        || (currentHour === 9 && currentMinute < 15)
        || currentHour > 15 
        || (currentHour === 15 && currentMinute >= 30)){
        strapi.isTradingEnabled = false;
      }else {
        strapi.isTradingEnabled = true;
      }
      let scripList = '';
      let otherScripItems = await strapi.db.query('api::web-socket.web-socket').findMany({
        where: { 
            scripList: { $ne: '' } // Exclude the current indexToken
        },
        select: ['scripList'], // Select only the scripList field
      });

      if (otherScripItems && otherScripItems.length > 0) {
          for (const otherScripItem of otherScripItems) {
              if (otherScripItem.scripList) {
                  scripList += `#${otherScripItem.scripList}`; // Concatenate with '#'
              }
          }
      }
    
    scripList.length > 0 && await strapi.service('api::web-socket.web-socket').connectFlattradeWebSocket(scripList);


      strapi.log.info(`is Trading enabled? ${strapi.isTradingEnabled} | Current Time: ${currentTime} | Current Hour: ${currentHour} | Current Minute: ${currentMinute}`);
    };
    setFoundation().then((result) => {
      strapi.log.info('WebSocket server initialized & Index Variables Fetched succesfully');     
      
    }).catch((error) => {
      console.error('Either WebSocket server initialization failed or Fetching Index Variables failed :', error);
    });
    
  },
};
