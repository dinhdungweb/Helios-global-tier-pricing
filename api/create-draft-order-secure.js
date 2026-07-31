/**
 * Shopify Draft Order API
 *
 * Prices, tier discounts, customer identity and free-gift eligibility are
 * derived from Shopify Admin data. Client-provided price/discount fields are
 * deliberately ignored.
 */

'use strict';

const crypto = require('crypto');
const {
  buildAuthoritativeItems,
  getTierPolicy,
  normalizeNumericId
} = require('../lib/tier-pricing-policy');

const SHOPIFY_SHOP = normalizeShopDomain(process.env.SHOPIFY_SHOP);
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const DEFAULT_CURRENCY = normalizeCurrency(
  process.env.SHOPIFY_CURRENCY || 'USD'
);
const DEFAULT_COUNTRY = normalizeCountry(
  process.env.SHOPIFY_COUNTRY || 'US'
);
const REQUIRE_APP_PROXY = parseBoolean(
  process.env.REQUIRE_APP_PROXY,
  true
);
const API_VERSION = '2026-07';
const MAX_ITEMS = 50;
const MAX_QUANTITY = 100;
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;
const MAX_PROXY_REQUEST_AGE_SECONDS = 300;
const ALLOWED_ORIGINS = new Set(
  String(
    process.env.ALLOWED_ORIGINS ||
    (SHOPIFY_SHOP ? `https://${SHOPIFY_SHOP}` : '')
  )
    .split(',')
    .map(value => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

module.exports = async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
    return res.status(500).json({
      error: 'Server configuration error',
      message: 'Missing Shopify server credentials'
    });
  }

  try {
    const proxyAuth = authenticateAppProxy(req);
    if (proxyAuth.attempted && !proxyAuth.valid) {
      return res.status(401).json({ error: proxyAuth.error });
    }
    if (REQUIRE_APP_PROXY && !proxyAuth.valid) {
      return res.status(401).json({
        error: 'A valid Shopify App Proxy request is required'
      });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const requestedItems = validateRequestedItems(body.items);
    const currency = normalizeCurrency(body.currency || DEFAULT_CURRENCY);
    const country = normalizeCountry(
      body.country || getQueryValue(req.query, 'country') || DEFAULT_COUNTRY
    );
    const customerId = proxyAuth.valid
      ? proxyAuth.customerId
      : normalizeCustomerId(body.customer_id);

    if (!currency) {
      return res.status(400).json({
        error: 'A valid 3-letter currency code is required'
      });
    }
    if (!country) {
      return res.status(400).json({
        error: 'A valid 2-letter country code is required'
      });
    }
    if (!customerId) {
      return res.status(401).json({
        error: 'A logged-in customer is required'
      });
    }

    const variantIds = [
      ...new Set(requestedItems.map(item => item.variant_id))
    ];
    const checkoutContext = await loadCheckoutContext({
      customerId,
      variantIds,
      country
    });

    if (!checkoutContext.customer) {
      return res.status(403).json({ error: 'Customer was not found' });
    }

    const variantsById = new Map(
      checkoutContext.variants
        .filter(Boolean)
        .map(variant => [
          normalizeNumericId(variant.id),
          variant
        ])
    );
    const policy = getTierPolicy();
    const authoritativeItems = buildAuthoritativeItems({
      requestedItems,
      variantsById,
      customer: checkoutContext.customer,
      currency,
      shopCurrency: checkoutContext.shopCurrency,
      policy
    });
    const lineItems = authoritativeItems.map(buildDraftOrderLineItem);
    const draftOrderInput = {
      lineItems,
      presentmentCurrencyCode: currency,
      useCustomerDefaultAddress: true,
      acceptAutomaticDiscounts: false,
      allowDiscountCodesInCheckout: false,
      purchasingEntity: {
        customerId: toCustomerGid(customerId)
      }
    };

    console.log('Creating authoritative draft order', {
      mode: proxyAuth.valid ? 'app_proxy' : 'legacy_server_verified',
      currency,
      country,
      itemCount: lineItems.length
    });

    const draftOrder = await createDraftOrderWithRetry(draftOrderInput);

    return res.status(200).json({
      success: true,
      invoice_url: draftOrder.invoiceUrl,
      draft_order_id: draftOrder.legacyResourceId,
      total_price: draftOrder.totalPriceSet.presentmentMoney.amount,
      currency: draftOrder.presentmentCurrencyCode,
      security_mode: proxyAuth.valid
        ? 'app_proxy'
        : 'legacy_server_verified'
    });
  } catch (error) {
    console.error('Draft order error:', {
      name: error.name,
      message: error.message,
      statusCode: error.statusCode || 500
    });

    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      error: statusCode === 422
        ? 'Shopify rejected the draft order'
        : statusCode >= 500
          ? 'Internal server error'
          : error.message,
      message: statusCode >= 500 ? undefined : error.message
    });
  }
};

function validateRequestedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw clientError(400, 'No items provided');
  }
  if (items.length > MAX_ITEMS) {
    throw clientError(400, `A maximum of ${MAX_ITEMS} items is allowed`);
  }

  return items.map((item, index) => {
    const variantId = normalizeNumericId(item && item.variant_id);
    const quantity = Number(item && item.quantity);

    if (!variantId) {
      throw clientError(400, `Item ${index}: a valid variant_id is required`);
    }
    if (
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > MAX_QUANTITY
    ) {
      throw clientError(
        400,
        `Item ${index}: quantity must be between 1 and ${MAX_QUANTITY}`
      );
    }

    return {
      variant_id: variantId,
      quantity
    };
  });
}

async function loadCheckoutContext({ customerId, variantIds, country }) {
  const query = `
    query CheckoutContext(
      $customerId: ID!
      $variantIds: [ID!]!
      $country: CountryCode!
    ) {
      shop {
        currencyCode
      }
      customer: node(id: $customerId) {
        ... on Customer {
          id
          tags
          amountSpent {
            amount
            currencyCode
          }
          totalSpentMetafield: metafield(
            namespace: "custom"
            key: "total_spent"
          ) {
            value
          }
        }
      }
      variants: nodes(ids: $variantIds) {
        ... on ProductVariant {
          id
          price
          compareAtPrice
          contextualPricing(context: { country: $country }) {
            price {
              amount
              currencyCode
            }
            compareAtPrice {
              amount
              currencyCode
            }
          }
          product {
            tags
            collections(first: 100) {
              nodes {
                handle
              }
            }
          }
        }
      }
    }
  `;

  const data = await executeAdminGraphQL(query, {
    customerId: toCustomerGid(customerId),
    variantIds: variantIds.map(toProductVariantGid),
    country
  });

  return {
    shopCurrency: normalizeCurrency(
      data.shop && data.shop.currencyCode
    ) || DEFAULT_CURRENCY,
    customer: data.customer,
    variants: Array.isArray(data.variants) ? data.variants : []
  };
}

function buildDraftOrderLineItem(item) {
  const lineItem = {
    variantId: toProductVariantGid(item.variantId),
    quantity: item.quantity
  };
  const shopUnitDiscountAmount = formatMoney(
    item.shopUnitDiscountAmount,
    item.shopCurrency
  );

  if (item.unitDiscountAmount > 0) {
    const discountTitle = item.isGift
      ? 'Free gift'
      : `Tier Discount ${normalizeDiscountPercent(item.discountPercent)}%`;
    const formattedDiscount = formatMoney(
      item.unitDiscountAmount,
      item.currency
    );

    lineItem.appliedDiscount = {
      title: discountTitle,
      description: discountTitle,
      valueType: 'FIXED_AMOUNT',
      // Both fixed-amount representations are per unit. Shopify multiplies
      // them by the line-item quantity when calculating the draft total.
      value: Number(shopUnitDiscountAmount),
      amountWithCurrency: {
        amount: formattedDiscount,
        currencyCode: item.currency
      }
    };
  }

  return lineItem;
}

async function createDraftOrderWithRetry(draftOrderInput, retryCount = 0) {
  const query = `
    mutation DraftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          legacyResourceId
          invoiceUrl
          presentmentCurrencyCode
          totalPriceSet {
            presentmentMoney {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const data = await executeAdminGraphQL(query, {
      input: draftOrderInput
    });
    const result = data.draftOrderCreate;

    if (!result) {
      throw new Error('Shopify returned an invalid draft order response');
    }
    if (Array.isArray(result.userErrors) && result.userErrors.length > 0) {
      const error = clientError(
        422,
        result.userErrors.map(item => item.message).join('; ')
      );
      throw error;
    }
    if (!result.draftOrder || !result.draftOrder.invoiceUrl) {
      throw new Error('Shopify did not return a draft order checkout URL');
    }

    console.log('Draft order created:', result.draftOrder.id);
    return result.draftOrder;
  } catch (error) {
    if (
      retryCount < MAX_RETRIES &&
      !error.statusCode &&
      (error.message.includes('fetch') || error.name === 'TypeError')
    ) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      await sleep(delay);
      return createDraftOrderWithRetry(draftOrderInput, retryCount + 1);
    }
    throw error;
  }
}

async function executeAdminGraphQL(query, variables, retryCount = 0) {
  const apiUrl =
    `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  if (response.status === 429 && retryCount < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
    await sleep(delay);
    return executeAdminGraphQL(query, variables, retryCount + 1);
  }

  if (!response.ok) {
    const responseBody = await response.text();
    const error = new Error(
      `Shopify API error: ${response.status} - ${responseBody}`
    );
    error.statusCode =
      response.status >= 400 && response.status < 500 ? 422 : 500;
    throw error;
  }

  const result = await response.json();
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const error = new Error(
      result.errors.map(item => item.message).join('; ')
    );
    error.statusCode = 422;
    throw error;
  }
  if (!result.data) {
    throw new Error('Shopify returned an invalid GraphQL response');
  }

  return result.data;
}

function authenticateAppProxy(req) {
  const signature = getQueryValue(req.query, 'signature');
  if (!signature) {
    return { attempted: false, valid: false, customerId: '' };
  }
  if (!SHOPIFY_API_SECRET) {
    return {
      attempted: true,
      valid: false,
      customerId: '',
      error: 'App Proxy authentication is not configured'
    };
  }

  const message = Object.keys(req.query || {})
    .filter(key => key !== 'signature')
    .sort()
    .map(key => {
      const value = req.query[key];
      return `${key}=${Array.isArray(value) ? value.join(',') : value}`;
    })
    .join('');
  const expectedSignature = crypto
    .createHmac('sha256', SHOPIFY_API_SECRET)
    .update(message)
    .digest('hex');

  if (!safeEqual(signature, expectedSignature)) {
    return {
      attempted: true,
      valid: false,
      customerId: '',
      error: 'Invalid App Proxy signature'
    };
  }

  const shop = normalizeShopDomain(getQueryValue(req.query, 'shop'));
  if (shop !== SHOPIFY_SHOP) {
    return {
      attempted: true,
      valid: false,
      customerId: '',
      error: 'Invalid App Proxy shop'
    };
  }

  const timestamp = Number(getQueryValue(req.query, 'timestamp'));
  const age = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
  if (!Number.isFinite(timestamp) || age > MAX_PROXY_REQUEST_AGE_SECONDS) {
    return {
      attempted: true,
      valid: false,
      customerId: '',
      error: 'Expired App Proxy request'
    };
  }

  const customerId = normalizeCustomerId(
    getQueryValue(req.query, 'logged_in_customer_id')
  );
  if (!customerId) {
    return {
      attempted: true,
      valid: false,
      customerId: '',
      error: 'A logged-in customer is required'
    };
  }

  return {
    attempted: true,
    valid: true,
    customerId
  };
}

function setCorsHeaders(req, res) {
  const origin = String(req.headers && req.headers.origin || '')
    .replace(/\/$/, '');
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getQueryValue(query, key) {
  const value = query && query[key];
  return Array.isArray(value) ? value[0] : value;
}

function normalizeCurrency(value) {
  const currency = String(value || '').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function normalizeCountry(value) {
  const country = String(value || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : '';
}

function normalizeShopDomain(value) {
  const domain = String(value || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .split('/')[0];
  if (!domain) {
    return '';
  }
  return domain.includes('.') ? domain : `${domain}.myshopify.com`;
}

function normalizeCustomerId(value) {
  const normalized = String(value || '')
    .replace('gid://shopify/Customer/', '')
    .trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function toProductVariantGid(variantId) {
  return `gid://shopify/ProductVariant/${normalizeNumericId(variantId)}`;
}

function toCustomerGid(customerId) {
  return `gid://shopify/Customer/${normalizeCustomerId(customerId)}`;
}

function normalizeDiscountPercent(percent) {
  const boundedPercent = Math.min(100, Math.max(0, Number(percent)));
  return Math.round((boundedPercent + Number.EPSILON) * 100) / 100;
}

function formatMoney(value, currency) {
  return Number(value).toFixed(getCurrencyPrecision(currency));
}

function getCurrencyPrecision(currency) {
  const zeroDecimalCurrencies = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW',
    'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
  ]);
  const threeDecimalCurrencies = new Set([
    'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'
  ]);
  return zeroDecimalCurrencies.has(currency)
    ? 0
    : threeDecimalCurrencies.has(currency)
      ? 3
      : 2;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value).trim().toLowerCase() === 'true';
}

function clientError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports._test = {
  authenticateAppProxy,
  buildDraftOrderLineItem,
  validateRequestedItems
};
