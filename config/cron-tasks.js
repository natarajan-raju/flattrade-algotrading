module.exports = {
    /**
     * Cron job to reset investment variables, purge orders, clear contract variables, stop trading, reset scrip list and set isTradingEnabled flag daily
     */
    dailyMorningJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading('1');
        await strapi.service('api::web-socket.web-socket').resetScripList();
        await strapi.service('api::purge.purge').purgeOrders();
        strapi.isTradingEnabled = false;
      },
      options: {
        rule: "00 07 * * *", // Every day at 7:00 AM
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    dailyMorningTradeJob: {
      task: async ({ strapi }) => {
        strapi.isTradingEnabled = true;
      },
      options: {
        rule: "15 09 * * *", // Every day at 09:15 AM
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    dailyEveningJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading('1');
        await strapi.service('api::web-socket.web-socket').resetScripList();        
        strapi.isTradingEnabled = false;
      },
      options: {
        rule: "30 15 * * *", // Every day at 3:15 pm
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    dailyMidnightJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading('1');
        await strapi.service('api::web-socket.web-socket').resetScripList();
        await strapi.service('api::purge.purge').purgeOrders();
        strapi.isTradingEnabled = false;
      },
      options: {
        rule: "00 00 * * *", // Every day at Midnight
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    
  };
  