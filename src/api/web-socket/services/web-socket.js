const WebSocket = require('ws');
const { env } = require('@strapi/utils');

module.exports = ({ strapi }) => ({
  flattradeWs: null,
  processingTokens: new Set(),
  

  async connectFlattradeWebSocket(userId, sessionToken, accountId, scripList) {
    // Fetch all WebSocket configuration entries and get the first one
    const webSocketConfigs = await strapi.entityService.findMany('api::web-socket.web-socket', {
      limit: 1, // Fetch only the first entry
    });
    const flattradeWsUrl = webSocketConfigs[0]?.flattradeClientUrl || env('FLATTRAD_WS_URL');

    if (!flattradeWsUrl) {
      throw new Error('WebSocket URL not found in database or environment.');
    }

    this.flattradeWs = new WebSocket(flattradeWsUrl);

    this.flattradeWs.on('open', () => {
      console.log('Flattrade WebSocket connection established.');
      this.sendConnectionRequest(userId, sessionToken, accountId);
    });

    this.flattradeWs.on('message', (data) => {
      const messageString = Buffer.isBuffer(data) ? data.toString() : data;
      const message = JSON.parse(messageString);
      this.handleIncomingMessage(message, scripList);
    });

    this.flattradeWs.on('close', () => {
      console.log('Flattrade WebSocket connection closed. Attempting reconnect...');
      setTimeout(() => this.connectFlattradeWebSocket(userId, sessionToken, accountId, scripList), 3000);
    });

    this.flattradeWs.on('error', (error) => {
      console.error('Flattrade WebSocket error:', error);
    });
  },

  sendConnectionRequest(userId, sessionToken, accountId) {
    const connectPayload = {
      t: 'c',
      uid: userId,
      actid: accountId,
      source: 'API',
      susertoken: sessionToken,
    };
    console.log('Sending connection request:', connectPayload);
    this.flattradeWs.send(JSON.stringify(connectPayload));
  },

  handleIncomingMessage(message, scripList) {
    // Define the specific touchline tokens to deduplicate
    const touchlineTokens = ['26000', '26014', '26037', '26013', '26019'];
  
    // Apply deduplication only if the message is a touchline feed and the token matches one of the specified ones
    if (message.t === 'tf' && touchlineTokens.includes(message.token)) {
      if (this.processingTokens.has(message.token)) {
        // Token is already in processing, ignore the message (duplicate)
        strapi.webSocket.broadcast({ type: 'variable', message: `No action taken at ${message.lp} for ${message.ts}`, status: true });
        strapi.db.query('api::variable.variable').update({ where: { token: message.token }, data: { previousTradedPrice: message.lp } });
        console.log(`Duplicate message ignored for token: ${message.token}`);
        return;
      }
      // Add token to processing set to mark it as being processed
      this.processingTokens.add(message.token);
    }
  
    // Handle message types
    switch (message.t) {
      case 'ck':
        if (message.s === 'OK') {
          console.log('Connection acknowledged for user:', message.uid);
          this.subscribeTouchline(scripList);
          this.subscribeOrderbook();
        } else {
          console.error('Connection failed: Invalid user ID or session token.');
        }
        break;
  
      case 'tk':
        // Subscription acknowledged: message
        break;
  
      case 'tf':
        // Handle Touchline Feed and after it's processed, remove the token
        this.handleTouchlineFeed(message)
          .finally(() => {
            // Remove token from processing set after feed handling
            if (this.processingTokens.has(message.token)) {
              this.processingTokens.delete(message.token);
              console.log(`Token ${message.token} removed from processingTokens set.`);
            }
          });
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
    this.flattradeWs.send(JSON.stringify(subscribePayload));
  },

  subscribeOrderbook() {
    const subscribePayload = {
      t: 'o',
      actid: `${env('FLATTRADE_ACCOUNT_ID')}`,
    };
    this.flattradeWs.send(JSON.stringify(subscribePayload));
  },

  async handleTouchlineFeed(feedData) {
    try {
      const result = await strapi.service('api::variable.variable').handleFeed(feedData);
    } catch (error) {
      console.error('Error processing feed:', error);
      throw error;
    }
  },

  async handleOrderbookFeed(feedData) {
    try {
      const result = await strapi.service('api::order.order').handleOrderbookFeed(feedData);
    } catch (error) {
      console.error('Error processing feed:', error);
    }
  },
});
