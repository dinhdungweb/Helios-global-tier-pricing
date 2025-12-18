/**
 * Simple health check endpoint
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
  const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
  
  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    config: {
      hasShop: !!SHOPIFY_SHOP,
      hasToken: !!SHOPIFY_ACCESS_TOKEN,
      shop: SHOPIFY_SHOP || 'not set',
      tokenLength: SHOPIFY_ACCESS_TOKEN ? SHOPIFY_ACCESS_TOKEN.length : 0
    }
  });
};
