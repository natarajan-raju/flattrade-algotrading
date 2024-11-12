module.exports = {
    /**
     * Cron job to reset investment variables every day at 5:00 PM.
     */
    dailyResetJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').resetInvestmentVariables();
      },
      options: {
        rule: "0 17 * * *", // Every day at 5:00 PM
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    dailyStopJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::variable.variable').stopTrading();
      },
      options: {
        rule: "15 15 * * *", // Every day at 3:15 PM
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
  };
  