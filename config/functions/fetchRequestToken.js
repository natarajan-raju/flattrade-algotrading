const { env } = require('@strapi/utils');

async function fetchRequestToken(){
    const headers = {
        Authorization: `Bearer ${env('SPECIAL_TOKEN')}`, // Including the special token in the Authorization header
    };
    
    // Retrieve all tokens (without any conditions)
    const existingTokens = await strapi.db.query('api::authentication.authentication').findMany({
        headers,
    });
    
    return {
        requestToken: existingTokens[0]?.requestToken || false,
        id: existingTokens[0]?.id || "",
    };
}

module.exports = {
    fetchRequestToken,
};


