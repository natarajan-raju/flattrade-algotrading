module.exports = {
    /**
     * Cron job to reset investment variables every day at 5:00 PM.
     */
    dailyMorningJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading(1);
      },
      options: {
        rule: "07 00 * * *", // Every day at 7:00 AM
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    dailyEveningJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading(1);
      },
      options: {
        rule: "15 15 * * *", // Every day at 3:15 pm
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
  };
  