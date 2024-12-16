module.exports = {
    /**
     * Cron job to reset investment variables every day at 5:00 PM.
     */
    dailyMorningJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading('1');
        await strapi.service('api::web-socket.web-socket').resetScripList();
      },
      options: {
        rule: "07 07 * * *", // Every day at 7:07 AM
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
    purgeOrderJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::purge.purge').purgeOrders();
      },
      options: {
        rule: "30 15 */3 * *", // Once in three days
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
  };
  