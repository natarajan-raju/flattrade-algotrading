const WebSocket = require('ws');
const { env } = require('@strapi/utils');

module.exports = ({ strapi }) => ({
  flattradeWs: null,
  processingTokens: new Set(),

  async initializeWebSocketServer(){
    const server = strapi.server.httpServer;
    // console.log(server);
    // Create a new WebSocket server attached to the Strapi HTTP server
    const wss = new WebSocket.Server({ server });
    // Store connected clients
    const clients = new Set();

    // When a new WebSocket connection is made
    wss.on('connection', (ws) => {
      strapi.log.info('New WebSocket client connected');
      clients.add(ws);

      // When the client disconnects
      ws.on('close', () => {
        strapi.log.info('WebSocket client disconnected');
        clients.delete(ws);
      });

      // Handle incoming messages (if needed)
      ws.on('message', (message) => {
        console.log('Received message from client:', message);
      });
    });

    // Broadcast a message to all connected WebSocket clients
    const broadcast = (data) => {
      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    };

    // Expose the broadcast function globally for other parts of the app
    strapi.webSocket = { broadcast };

    strapi.log.info('WebSocket server is running');
  },
  

  async connectFlattradeWebSocket(scripList) {

    const handleSigint = function () {
      if (this.flattradeWs && this.flattradeWs.readyState === WebSocket.OPEN) {
        this.flattradeWs.close();
        strapi.log.info('Flattrade WebSocket connection closed gracefully.');
      }
      process.exit(0);
    }.bind(this);

    // Remove any existing listener to avoid duplicates
    process.removeAllListeners('SIGINT');

    // Add the SIGINT listener
    process.on('SIGINT', handleSigint);
    // Fetch all WebSocket configuration entries and get the first one
    
    const flattradeWsUrl = env('FLATTRADE_WS_URL');

    if (!flattradeWsUrl) {
      strapi.log.info('WebSocket URL not found in database or environment.');
    }

    this.flattradeWs = new WebSocket(flattradeWsUrl);

    this.flattradeWs.on('open', async () => {
      strapi.log.info('Flattrade WebSocket connection established.');
      this.sendConnectionRequest();
    });

    this.flattradeWs.on('message', (data) => {
      const messageString = Buffer.isBuffer(data) ? data.toString() : data;
      const message = JSON.parse(messageString);
      this.handleIncomingMessage(message,scripList);
    });

    this.flattradeWs.on('close', () => {
      strapi.log.info('Flattrade WebSocket connection closed.Attempting to reconnect...');
      strapi.webSocket.broadcast({
        type: 'variable',
        message: 'Flattrade WebSocket connection closed. Attempting reconnect...',
        status: false,
      });
      const currentTime = new Date();
      const currentHour = currentTime.getHours();
      const currentMinute = currentTime.getMinutes();
      if ((currentHour > 8 && currentHour < 15) || (currentHour === 8 && currentMinute >= 0) || (currentHour === 15 && currentMinute <= 30)){        
        setTimeout(() => this.connectFlattradeWebSocket(scripList), 3000);
      } else {
        strapi.log.info('Outisde Market hours. Websocket will not attempt to reconnect.');
        strapi.webSocket.broadcast({
          type: 'action',
          message: 'Outside Market hours. Please try again between 09:00 hrs and 03:30 hrs',
          status: false,
        });
      }     
      
  });
  

    this.flattradeWs.on('error', (error) => {
      strapi.webSocket.broadcast({ type: 'action', message: `Flattrade WebSocket error: ${error}`, status: false });
      console.error('Flattrade WebSocket error:', error);
    });

      // Graceful shutdown on SIGINT (Ctrl+C)
     
  },

  async sendConnectionRequest() {
    const uid = env('FLATTRADE_USER_ID');
    const actid = env('FLATTRADE_ACCOUNT_ID');
    const sessionTokenResponse = await strapi.service('api::authentication.authentication').fetchRequestToken();
    const sessionToken = sessionTokenResponse.requestToken;
    const connectPayload = {
      t: 'c',
      uid,
      actid,
      source: 'API',
      susertoken: sessionToken,
    };
    console.log('Sending connection request:', connectPayload);
    this.flattradeWs.send(JSON.stringify(connectPayload));
  },

  async handleIncomingMessage(message,scripList) {
    // Define the specific touchline tokens to deduplicate
    const touchlineTokens = ['26000', '26014', '26037', '26013', '26009'];
  
    // Apply deduplication only if the message is a touchline feed and the token matches one of the specified ones
    if (message.t === 'tf' && touchlineTokens.includes(message.tk) && message.lp) {
      if (this.processingTokens.has(message.tk)) {
        // Token is already in processing, ignore the message (duplicate)
        strapi[`${message.tk}`].set('previousTradedPrice', message.lp);      
        strapi.webSocket.broadcast({ type: 'variable', message: `No action taken at ${message.lp} for ${message.tk}`, status: true });
        console.log(`Preventing concurrent orders for token: ${message.tk}`);
        return;
      }     
    }
  
    // Handle message types
    switch (message.t) {
      case 'ck':
        if (message.s === 'OK') {
          console.log('Connection acknowledged for user:', message.uid);          
          await this.subscribeTouchline(scripList);         
          await this.subscribeOrderbook();
          // this.subscribeOrderbook();
        } else {
          console.error('Connection failed: Invalid user ID or session token.');
        }
        break;

      case 'ok':
        console.log('Order book subscribed');
        break;

      case 'tk': 
        // console.log('Subscribed to touchline feed for token:', message.tk);      
        break;
  
      case 'tf':
        // Handle Touchline Feed and after it's processed, remove the token
        if(message.lp){
          if(touchlineTokens.includes(message.tk)){
              if(!this.processingTokens.has(message.tk)){
                this.processingTokens.add(message.tk);
                try {
                  await strapi.service('api::variable.variable').handleFeed(message);
                } catch (error) {
                  console.error(`Error handling feed for token ${message.tk}:`, error);
                  strapi.webSocket.broadcast({ type: 'variable', message: `Error handling feed for token ${message.tk}: ${error}..Consider restarting the application..`, status: false });
                } finally {
                  this.processingTokens.delete(message.tk);
                }
              } else {
                console.log(`Preventing concurrent action for token: ${message.tk} due to incoming data burst`);
                strapi[`${message.tk}`].set('previousTradedPrice', message.lp);
                
              }
          }else {
            try {
              await strapi.service('api::variable.variable').handleFeed(message);
            } catch (error) {
              console.error(`Error handling feed for token ${message.tk}:`, error);
            }          
          }
        }
        break;
  
      case 'om':
        this.handleOrderbookFeed(message);
        break;
  
      case 'uk':
        console.log('Unsubscription acknowledged:', message);
        break;
  
      default:
        strapi.webSocket.broadcast({ type: 'action', message, status: true });
        console.log('Unknown message type:', message);
    }
  },

  async subscribeTouchline(scripList) {
    
    const subscribePayload = {
      t: 't',
      k: scripList,
    };

    if (!this.flattradeWs) {
      console.error('WebSocket is not initialized. Connecting...');
      await this.connectFlattradeWebSocket();
    }
    if(this.flattradeWs.readyState === WebSocket.OPEN){
      strapi.log.info('Flattrade WebSocket connection is open..Subscribing to touchline..');
      this.flattradeWs.send(JSON.stringify(subscribePayload));
    } else {
      await this.connectFlattradeWebSocket();
      if(this.flattradeWs.readyState === WebSocket.OPEN){
        strapi.log.info('Flattrade WebSocket connection is open..Subscribing to touchline..');
        this.flattradeWs.send(JSON.stringify(subscribePayload));
      }
    }
  },

  async unsubscribeTouchline(scripList) {
    console.log(`Unsubscribing from ${scripList}`);
    const unsubscribePayload = {
      t: 'u',
      k: scripList,
    };
    await this.flattradeWs.send(JSON.stringify(unsubscribePayload));
  },

  async subscribeOrderbook() {
    // const subscribePayload = {
    //   t: 'o',
    //   actid: `${env('FLATTRADE_ACCOUNT_ID')}`,
    // };        
    
    if (!this.flattradeWs) {
      console.error('WebSocket is not initialized. Connecting...');
      await this.connectFlattradeWebSocket();
    }
    if(this.flattradeWs.readyState === WebSocket.OPEN){
      strapi.log.info('Flattrade WebSocket connection is open..Subscribing to orderbook..');
      this.flattradeWs.send(JSON.stringify({
        t: 'o',
        actid: `${env('FLATTRADE_ACCOUNT_ID')}`,
      }));
    } else {
      await this.connectFlattradeWebSocket();
      if(this.flattradeWs.readyState === WebSocket.OPEN){
        strapi.log.info('Flattrade WebSocket connection is open..Subscribing to orderbook..');
        this.flattradeWs.send(JSON.stringify({
          t: 'o',
          actid: `${env('FLATTRADE_ACCOUNT_ID')}`,
        }));
      }
    }
  },

  async handleOrderbookFeed(feedData) {
    console.log('Order update Received');
    console.log(feedData);
    console.table(feedData);
    // strapi.log.info('Order update received..');
    try {
      await strapi.service('api::order.order').handleOrderbookFeed(feedData);
    } catch (error) {
      strapi.webSocket.broadcast({ type: 'variable', message: `Error handling orderbook feed: ${error}..Consider restarting the application..`, status: false });
      throw new Error(error);    
    }
  },

  //Cron Job to reset scripList
  async resetScripList() {
    
    for (const indexToken of strapi.INDICES) {
      strapi.db.query('api::web-socket.web-socket').update({where: { indexToken }, data: { scripList: '' }});
      // if(strapi[`${indexToken}`]){
      //   strapi[`${indexToken}`].set('scripList', '');        
      // } 
    }
    strapi.log.info('ScripList reset successfully.');
    strapi.webSocket.broadcast({ type: 'action', message: 'ScripList reset successfully.', status: true });  
  } 
});
