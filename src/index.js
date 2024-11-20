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
};
