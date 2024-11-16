'use strict';
const { env } = require('@strapi/utils');
// @ts-ignore
const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::order.order', ({ strapi }) => ({

    // Helper function to get the preferred token
    async getPreferredToken(contractTokens, contractType, targetAmount) {
        // Select the appropriate array based on contract type
        const tokensArray = contractType === 'CALL' ? contractTokens.call : contractTokens.put;
      
        // Find the token with the `lp` closest to `targetAmount`
        let closestTokenData = {token: null, lp: Infinity, tsym: null};
        let smallestDifference = Infinity;
      
        tokensArray.forEach(tokenData => {
          if(tokenData.lp > targetAmount){
            const difference = Math.abs(tokenData.lp - targetAmount);
            if (difference < smallestDifference) {
                smallestDifference = difference;
                closestTokenData = tokenData;
            }
          }  
          
        });
      
        return closestTokenData ? closestTokenData.token : null; // Return token ID or null if not found
    },
      
    

    // Place Order service
    async placeBuyOrder(orderData) {
        try {
            const {  contractType, lp, contract, sessionToken, amount } = orderData;
            if (!contract ) {
                return {
                    status: false,
                    message: 'Error setting initial values. Please try again'
                };
            }
            const preferredToken = await this.getPreferredToken(contract.contractTokens, contractType, amount);
            console.log(preferredToken,preferredToken.lp);
            if(preferredToken.token){
                const createdOrder = await strapi.db.query('api::order.order').create({
                    data: {
                        index: contract.index,
                        orderType: 'BUY',
                        contractType,                       
                        contractToken: preferredToken.token,
                        boughtAtLtp: preferredToken.lp,
                        contractTsym: preferredToken.tsym,
                    }
                });
                return {
                    status: true,
                    message: 'Order placed successfully',
                    data: createdOrder
                }
            } else {
                return {
                    status: false,
                    message: 'No suitable tokens found for the order.'
                }
            }           
        } catch (error) {
            return {
                status: false,
                message: error.message || 'An error occurred while placing the order.'
            };
        }
    },

}));
