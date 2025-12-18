/**
 * Simple local test without Vercel CLI
 */

require('dotenv').config();

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

async function testShopifyConnection() {
  console.log('Testing Shopify connection...\n');
  
  console.log('Config:');
  console.log('- SHOPIFY_SHOP:', SHOPIFY_SHOP);
  console.log('- Token prefix:', SHOPIFY_ACCESS_TOKEN?.substring(0, 10) + '...');
  console.log('- Token length:', SHOPIFY_ACCESS_TOKEN?.length);
  console.log('- API Version:', API_VERSION);
  console.log('');
  
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    console.error('❌ Missing environment variables!');
    return;
  }
  
  try {
    const testUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/shop.json`;
    console.log('Testing URL:', testUrl);
    console.log('');
    
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      }
    });
    
    console.log('Response status:', response.status, response.statusText);
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ Connection successful!');
      console.log('Shop name:', data.shop.name);
      console.log('Shop domain:', data.shop.domain);
      console.log('Shop email:', data.shop.email);
    } else {
      const errorText = await response.text();
      console.error('❌ Connection failed!');
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testShopifyConnection();
