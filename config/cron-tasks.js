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
    dailyEveningJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading('1');
        await strapi.service('api::web-socket.web-socket').resetScripList();
      },
      options: {
        rule: "34 18 * * *", // Every day at 3:15 pm
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
  };
  