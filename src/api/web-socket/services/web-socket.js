const WebSocket = require('ws');
const { env } = require('@strapi/utils');

module.exports = ({ strapi }) => ({
  flattradeWs: null,
  processingTokens: new Set(),

  async initializeWebSocketServer(){
    const server = strapi.server.httpServer;

    // Create a new WebSocket server attached to the Strapi HTTP server
    const wss = new WebSocket.Server({ server });

    // Store connected clients
    const clients = new Set();

    // When a new WebSocket connection is made
    wss.on('connection', (ws) => {
      console.log('New WebSocket client connected');
      clients.add(ws);

      // When the client disconnects
      ws.on('close', () => {
        console.log('WebSocket client disconnected');
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

    console.log('WebSocket server is running');
  },
  

  async connectFlattradeWebSocket() {
    // Fetch all WebSocket configuration entries and get the first one
    
    const flattradeWsUrl = env('FLATTRADE_WS_URL');

    if (!flattradeWsUrl) {
      console.log('WebSocket URL not found in database or environment.');
    }

    this.flattradeWs = new WebSocket(flattradeWsUrl);

    this.flattradeWs.on('open', async () => {
      console.log('Flattrade WebSocket connection established.');
      this.sendConnectionRequest();
    });

    this.flattradeWs.on('message', (data) => {
      const messageString = Buffer.isBuffer(data) ? data.toString() : data;
      const message = JSON.parse(messageString);
      this.handleIncomingMessage(message);
    });

    this.flattradeWs.on('close', () => {
      console.log('Flattrade WebSocket connection closed. Checking for existing scripList before reconnecting...');
      
      // Collect scripLists
      let scripLists = [];
      let scripString = '';
      for (const indexToken of strapi.INDICES) {
          if (strapi[`${indexToken}`]) {
              scripString = strapi[`${indexToken}`].get('scripList');
          }
          if (scripString) {
              scripLists.push(scripString);
          }
      }
  
      // Join scripLists if any exist
      const scripList = scripLists.length > 0 ? scripLists.join('#') : null;
  
      // Attempt reconnect only if a scripList exists
      if (scripList) {
          console.log('ScripList exists. Attempting WebSocket reconnect...');
          strapi.webSocket.broadcast({
              type: 'variable',
              message: 'Flattrade WebSocket connection closed. Attempting reconnect...',
              status: false,
          });
          setTimeout(() => this.connectFlattradeWebSocket(), 3000);
      } else {
          console.log('No scripList found. WebSocket will not attempt to reconnect.');
          strapi.webSocket.broadcast({
              type: 'variable',
              message: 'WebSocket connection closed. No scripList found, not reconnecting.',
              status: false,
          });
      }
  });
  

    this.flattradeWs.on('error', (error) => {
      strapi.webSocket.broadcast({ type: 'action', message: `Flattrade WebSocket error: ${error}`, status: false });
      console.error('Flattrade WebSocket error:', error);
    });

    // Graceful shutdown on SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      if (this.flattradeWs && this.flattradeWs.readyState === WebSocket.OPEN) {
        this.flattradeWs.close();
        console.log('Flattrade WebSocket connection closed gracefully.');
      }
      process.exit(0);
    });
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

  async handleIncomingMessage(message) {
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
          let scripLists = [];
          let scripString = '';
          let scripList = '';
          for (const indexToken of strapi.INDICES) { 
            if(strapi[`${indexToken}`]){
              scripString = strapi[`${indexToken}`].get('scripList');              
            }           
            if(scripString){
              scripLists.push(scripString);
            }            
          }
          if(scripLists.length > 0){
            scripList = scripLists.join('#');
          }
          if(scripList.length > 0){
            this.subscribeTouchline(scripList);
          }

          
          // this.subscribeOrderbook();
        } else {
          console.error('Connection failed: Invalid user ID or session token.');
        }
        break;
  
      case 'tk':       
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
        console.log('Unknown message type:', message);
    }
  },

  subscribeTouchline(scripList) {
    const subscribePayload = {
      t: 't',
      k: scripList,
    };
    if(this.flattradeWs.readyState === WebSocket.OPEN){
      console.log('Flattrade WebSocket connection is open..Subscribing to touchline..');
      this.flattradeWs.send(JSON.stringify(subscribePayload));
    } else {
      this.connectFlattradeWebSocket();
      this.flattradeWs.send(JSON.stringify(subscribePayload));
    }
  },

  unsubsribeTouchline(scripList) {
    
    const unsubscribePayload = {
      t: 'u',
      k: scripList,
    };
    this.flattradeWs.send(JSON.stringify(unsubscribePayload));
  },

  subscribeOrderbook() {
    const subscribePayload = {
      t: 'o',
      actid: `${env('FLATTRADE_ACCOUNT_ID')}`,
    };
    this.flattradeWs.send(JSON.stringify(subscribePayload));
  },

  async handleOrderbookFeed(feedData) {
    try {
      await strapi.service('api::order.order').handleOrderbookFeed(feedData);
    } catch (error) {
      strapi.webSocket.broadcast({ type: 'variable', message: `Error handling orderbook feed: ${error}..Consider restarting the application..`, status: false });
      throw new Error(error);    
    }
  },

  //Cron Job to reset scripList
  async resetScripList() {    
    await strapi.db.query('api::web-socket.web-socket').updateMany({ data: { scripList: '' } });
    for (const indexToken of strapi.INDICES) { 
      if(strapi[`${indexToken}`]){
        strapi[`${indexToken}`].set('scripList', '');        
      } 
    }
    console.log('ScripList reset successfully.');
    strapi.webSocket.broadcast({ type: 'action', message: 'ScripList reset successfully.', status: true });  
  } 
});
