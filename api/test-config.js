/**
 * Test endpoint to verify Shopify configuration
 */

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Check environment variables
  const config = {
    hasShop: !!SHOPIFY_SHOP,
    hasToken: !!SHOPIFY_ACCESS_TOKEN,
    shop: SHOPIFY_SHOP,
    tokenPrefix: SHOPIFY_ACCESS_TOKEN ? SHOPIFY_ACCESS_TOKEN.substring(0, 10) + '...' : 'missing',
    tokenLength: SHOPIFY_ACCESS_TOKEN ? SHOPIFY_ACCESS_TOKEN.length : 0,
    apiVersion: API_VERSION
  };
  
  console.log('Config check:', config);
  
  // Test Shopify API connection
  if (SHOPIFY_SHOP && SHOPIFY_ACCESS_TOKEN) {
    try {
      const testUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/shop.json`;
      console.log('Testing connection to:', testUrl);
      
      const response = await fetch(testUrl, {
        method: 'GET',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      });
      
      console.log('Test response status:', response.status);
      
      if (response.ok) {
        const data = await response.json();
        return res.status(200).json({
          success: true,
          message: 'Configuration is correct!',
          config: config,
          shopName: data.shop.name,
          shopDomain: data.shop.domain
        });
      } else {
        const errorText = await response.text();
        console.error('Test failed:', errorText);
        return res.status(200).json({
          success: false,
          message: 'Configuration error',
          config: config,
          error: {
            status: response.status,
            statusText: response.statusText,
            body: errorText
          }
        });
      }
    } catch (error) {
      console.error('Test error:', error);
      return res.status(200).json({
        success: false,
        message: 'Connection error',
        config: config,
        error: error.message
      });
    }
  }
  
  return res.status(200).json({
    success: false,
    message: 'Missing configuration',
    config: config
  });
};
