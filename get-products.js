/**
 * Get products and variants from Shopify
 */

require('dotenv').config();

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

async function getProducts() {
  console.log('Fetching products...\n');
  
  try {
    const apiUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/products.json?limit=5`;
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      }
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log(`Found ${data.products.length} products:\n`);
      
      data.products.forEach(product => {
        console.log(`Product: ${product.title}`);
        console.log(`  ID: ${product.id}`);
        product.variants.forEach(variant => {
          console.log(`  - Variant: ${variant.title}`);
          console.log(`    Variant ID: ${variant.id}`);
          console.log(`    Price: ${variant.price}`);
        });
        console.log('');
      });
    } else {
      const errorText = await response.text();
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

getProducts();
