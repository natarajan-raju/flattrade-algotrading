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
        await strapi.service('api::profit.profit').calculateProfits();
        await strapi.service('api::authentication.authentication').clearAuthentications();
        strapi.chosenContract = null;
        strapi.target = 0;
        strapi.entry = 0;
        strapi.stopLoss = 0;
        strapi.preferredContracts = new Set();
        strapi.amountTradingCounter = 0;
        // strapi.chosenContract = {token: null, lp: Infinity, tsym: null, ls: null, rsi: 0};   
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
        for (const indexToken of strapi.INDICES) {
          await strapi.service('api::variable.variable').getQuote(indexToken, true);
          try{
          strapi[`${indexToken}`].get('intervalId') && clearInterval(strapi[`${indexToken}`].get('intervalId'));
          }catch(e){
            continue;
          }
        }
        await strapi.service('api::variable.variable').resetInvestmentVariables();
        await strapi.service('api::contract.contract').clearContractVariables();
        await strapi.service('api::variable.variable').stopTrading('1');
        await strapi.service('api::web-socket.web-socket').resetScripList();
        // strapi.chosenContract = {token: null, lp: Infinity, tsym: null, ls: null, rsi: 0};
        strapi.isTradingEnabled = false;
        strapi.chosenContract = null;
        strapi.target = 0;
        strapi.entry = 0;
        strapi.stopLoss = 0;
        strapi.preferredContracts = new Set();
        strapi.amountTradingCounter = 0;
      },
      options: {
        rule: "45 15 * * *", // Every day at 3:45 pm
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    dailyNightJob: {
      task: async ({ strapi }) => {
        for (const indexToken of strapi.INDICES) {
          await strapi.service('api::variable.variable').getQuote(indexToken, true);
        }
        strapi.isTradingEnabled = false;
      },
      options: {
        rule: "00 23 * * *", // Every day at 11:00 PM
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
        // strapi.chosenContract = {token: null, lp: Infinity, tsym: null, ls: null, rsi: 0};
        strapi.isTradingEnabled = false;
        strapi.chosenContract = null;
        strapi.target = 0;
        strapi.entry = 0;
        strapi.stopLoss = 0;
        strapi.preferredContracts = new Set();
        strapi.amountTradingCounter = 0;
      },
      options: {
        rule: "00 00 * * *", // Every day at Midnight
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    monthlyEndJob: {
      task: async ({ strapi }) => {
        await strapi.service('api::purge.purge').deletePurgeTableMonthly();
        console.log('Purged data deleted');
      },
      options: {
        rule: "0 0 2 * *", // Monthly once on 2 day
        tz: "Asia/Kolkata",  // Set to your desired timezone
      },
    },
    
  };
  