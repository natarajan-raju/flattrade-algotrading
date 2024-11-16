const WebSocket = require('ws');
const { env } = require('@strapi/utils');
const fs = require( 'fs' );

module.exports = ({ strapi }) => ({
  flattradeWs: null,

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
      setTimeout(() => this.connectFlattradeWebSocket(userId, sessionToken, accountId,scripList), 3000);
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
    console.log('Received message:', message);

    switch (message.t) {
      case 'ck':
        if (message.s === 'OK') {
          console.log('Connection acknowledged for user:', message.uid);
          this.subscribeTouchline(scripList);
        } else {
          console.error('Connection failed: Invalid user ID or session token.');
        }
        break;

      case 'tk':
        console.log('Subscription acknowledged:', message);
        let text = message;
        text += '\n';
        fs.appendFile('D:/output.txt',text,(err) => {
          if(err) throw err;            
        });
        break;

      case 'tf':
        console.log('Touchline feed:', message);
        this.handleTouchlineFeed(message);
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
    console.log('Subscribing to touchline data for:', scripList);
    this.flattradeWs.send(JSON.stringify(subscribePayload));
  },

  async handleTouchlineFeed(feedData) {
    try {    
      const result = await strapi.service('api::variable.variable').handleFeed(feedData);
      console.log('Feed processed by controller:', result);
    } catch (error) {
      console.error('Error processing feed:', error);
    }
  },
});
