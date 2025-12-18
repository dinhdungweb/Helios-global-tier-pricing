/**
 * Shopify Draft Order API
 * Create draft order with line item discounts for tier pricing
 * 
 * Deploy to: Vercel, Netlify, or any serverless platform
 */

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // your-shop.myshopify.com
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN; // Admin API access token
const API_VERSION = '2024-10'; // Shopify API version

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second

// Tier discount configuration (MUST match theme settings)
const TIER_DISCOUNTS = {
  'BLACK DIAMOND': 10,
  'BLACKDIAMOND': 10,
  'DIAMOND': 8,
  'PLATINUM': 6,
  'GOLD': 4,
  'SILVER': 2,
  'MEMBER': 0
};

// All valid tier tags (for matching customer tags)
const VALID_TIER_TAGS = ['BLACK DIAMOND', 'BLACKDIAMOND', 'DIAMOND', 'PLATINUM', 'GOLD', 'SILVER', 'MEMBER'];

/**
 * Get customer tier from Shopify API
 * @param {string} customerId - Shopify customer ID
 * @returns {Promise<{tier: string|null, discount: number}>}
 */
async function getCustomerTier(customerId) {
  if (!customerId) {
    return { tier: null, discount: 0 };
  }

  try {
    const response = await fetch(
      `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );

    if (!response.ok) {
      console.error('Failed to fetch customer:', response.status);
      return { tier: null, discount: 0 };
    }

    const data = await response.json();
    const customerTags = data.customer?.tags || '';
    const tagsArray = customerTags.split(',').map(t => t.trim().toUpperCase());

    // Find matching tier (priority order: higher tiers first)
    for (const tierTag of VALID_TIER_TAGS) {
      if (tagsArray.includes(tierTag.toUpperCase())) {
        const discount = TIER_DISCOUNTS[tierTag] || 0;
        console.log(`Customer ${customerId} has tier: ${tierTag}, discount: ${discount}%`);
        return { tier: tierTag, discount };
      }
    }

    // No tier tag found
    console.log(`Customer ${customerId} has no tier tag`);
    return { tier: null, discount: 0 };
  } catch (error) {
    console.error('Error fetching customer tier:', error);
    return { tier: null, discount: 0 };
  }
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate environment variables
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Missing SHOPIFY_SHOP or SHOPIFY_ACCESS_TOKEN environment variables'
    });
  }

  // Log config (without exposing full token)
  console.log('Config:', {
    shop: SHOPIFY_SHOP,
    tokenPrefix: SHOPIFY_ACCESS_TOKEN?.substring(0, 10) + '...',
    apiVersion: API_VERSION
  });

  try {
    const { customer_id, items, customer_email } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }

    // Validate items
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.variant_id) {
        return res.status(400).json({ error: `Item ${i}: variant_id is required` });
      }
      if (!item.quantity || item.quantity <= 0) {
        return res.status(400).json({ error: `Item ${i}: quantity must be greater than 0` });
      }
      if (item.price === undefined || item.price < 0) {
        return res.status(400).json({ error: `Item ${i}: price must be a positive number` });
      }
      if (item.discount_percent < 0 || item.discount_percent > 100) {
        return res.status(400).json({ error: `Item ${i}: discount_percent must be between 0 and 100` });
      }
    }

    console.log('Creating draft order:', { customer_id, items });

    // SECURITY: Fetch customer tier from Shopify and override frontend discount
    const { tier: customerTier, discount: serverDiscount } = await getCustomerTier(customer_id);
    console.log('Server-validated tier:', { customerTier, serverDiscount });

    // Build line items with SERVER-VALIDATED discounts (override frontend)
    const lineItems = items.map(item => {
      const lineItem = {
        variant_id: item.variant_id,
        quantity: item.quantity
      };

      // Use server-calculated discount, NOT frontend discount_percent
      // This prevents malicious users from sending fake discount values
      if (serverDiscount > 0) {
        lineItem.applied_discount = {
          description: `${customerTier} Tier Discount ${serverDiscount}%`,
          value_type: 'percentage',
          value: serverDiscount.toString(),
          amount: calculateDiscountAmount(item.price, item.quantity, serverDiscount)
        };
      }

      return lineItem;
    });

    // Create draft order payload
    const draftOrderData = {
      line_items: lineItems,
      use_customer_default_address: true
    };

    // Add customer info
    if (customer_id) {
      draftOrderData.customer = { id: customer_id };
    } else if (customer_email) {
      draftOrderData.email = customer_email;
    }

    // Call Shopify API with retry logic
    const apiUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/draft_orders.json`;
    console.log('Calling Shopify API:', apiUrl);
    console.log('Draft order data:', JSON.stringify(draftOrderData, null, 2));

    const draftOrder = await createDraftOrderWithRetry(apiUrl, draftOrderData);

    if (!draftOrder) {
      return res.status(500).json({
        error: 'Failed to create draft order after retries'
      });
    }

    // Return invoice URL directly
    // Do NOT complete the draft order via API, otherwise it converts to an Order 
    // and the invoice URL becomes invalid (marked as paid/completed).
    return res.status(200).json({
      success: true,
      invoice_url: draftOrder.invoice_url,
      draft_order_id: draftOrder.id,
      total_price: draftOrder.total_price
    });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
};

/**
 * Create draft order with retry logic for rate limiting
 */
async function createDraftOrderWithRetry(apiUrl, draftOrderData, retryCount = 0) {
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify({ draft_order: draftOrderData })
    });

    console.log('Shopify API response status:', response.status);

    // Handle rate limiting (429)
    if (response.status === 429) {
      if (retryCount < MAX_RETRIES) {
        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : INITIAL_RETRY_DELAY * Math.pow(2, retryCount);

        console.log(`Rate limited. Retrying after ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);

        await sleep(delay);
        return createDraftOrderWithRetry(apiUrl, draftOrderData, retryCount + 1);
      } else {
        console.error('Max retries reached for rate limiting');
        throw new Error('Shopify API rate limit exceeded. Please try again later.');
      }
    }

    // Handle other errors
    if (!response.ok) {
      const error = await response.text();
      console.error('Shopify API error:', {
        status: response.status,
        statusText: response.statusText,
        body: error
      });

      // Retry on server errors (5xx)
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
        console.log(`Server error. Retrying after ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);

        await sleep(delay);
        return createDraftOrderWithRetry(apiUrl, draftOrderData, retryCount + 1);
      }

      throw new Error(`Shopify API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    console.log('Draft order created:', data.draft_order.id);

    return data.draft_order;

  } catch (error) {
    if (retryCount < MAX_RETRIES && error.message.includes('fetch')) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`Network error. Retrying after ${delay}ms (attempt ${retryCount + 1}/${MAX_RETRIES})`);

      await sleep(delay);
      return createDraftOrderWithRetry(apiUrl, draftOrderData, retryCount + 1);
    }

    throw error;
  }
}

/**
 * Sleep utility for retry delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate discount amount
 */
function calculateDiscountAmount(price, quantity, percent) {
  const totalPrice = price * quantity;
  const discountAmount = (totalPrice * percent / 100).toFixed(2);
  return discountAmount;
}
