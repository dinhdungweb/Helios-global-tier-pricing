/**
 * Test creating draft order locally
 */

require('dotenv').config();

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

async function testCreateDraftOrder() {
  console.log('Testing draft order creation...\n');
  
  const draftOrderData = {
    line_items: [
      {
        variant_id: 46876438200541, // Aegis Chrysaber Helios Silver - Size 6
        quantity: 1,
        applied_discount: {
          description: 'Tier Discount 15%',
          value_type: 'percentage',
          value: '15',
          amount: '147750.00'
        }
      }
    ],
    email: 'customer@example.com',
    use_customer_default_address: true
  };
  
  console.log('Draft order data:', JSON.stringify(draftOrderData, null, 2));
  console.log('');
  
  try {
    const apiUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/draft_orders.json`;
    console.log('Calling:', apiUrl);
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ draft_order: draftOrderData })
    });
    
    console.log('Response status:', response.status, response.statusText);
    console.log('');
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ Draft order created successfully!');
      console.log('Draft order ID:', data.draft_order.id);
      console.log('Invoice URL:', data.draft_order.invoice_url);
      console.log('Total price:', data.draft_order.total_price);
    } else {
      const errorText = await response.text();
      console.error('❌ Failed to create draft order');
      console.error('Error:', errorText);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testCreateDraftOrder();
