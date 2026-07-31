'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.SHOPIFY_SHOP = 'helios-global.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test-token';
process.env.SHOPIFY_API_SECRET = 'test-secret';
process.env.REQUIRE_APP_PROXY = 'true';

const handler = require('../api/create-draft-order-secure');
const {
  authenticateAppProxy,
  buildDraftOrderLineItem,
  validateRequestedItems
} = handler._test;

function createSignedQuery(customerId = '12345') {
  const query = {
    logged_in_customer_id: customerId,
    path_prefix: '/apps/helios-tier-pricing',
    shop: 'helios-global.myshopify.com',
    timestamp: String(Math.floor(Date.now() / 1000))
  };
  const message = Object.keys(query)
    .sort()
    .map(key => `${key}=${query[key]}`)
    .join('');
  query.signature = crypto
    .createHmac('sha256', 'test-secret')
    .update(message)
    .digest('hex');
  return query;
}

test('validates Shopify App Proxy signature and customer identity', () => {
  const result = authenticateAppProxy({ query: createSignedQuery() });

  assert.equal(result.valid, true);
  assert.equal(result.customerId, '12345');
});

test('rejects forged App Proxy requests', () => {
  const result = authenticateAppProxy({
    query: {
      signature: 'not-valid',
      shop: 'helios-global.myshopify.com',
      timestamp: String(Math.floor(Date.now() / 1000))
    }
  });

  assert.equal(result.valid, false);
  assert.equal(result.error, 'Invalid App Proxy signature');
});

test('validates variant IDs and quantity limits', () => {
  assert.deepEqual(
    validateRequestedItems([{ variant_id: '123', quantity: 2 }]),
    [{ variant_id: '123', quantity: 2 }]
  );
  assert.throws(
    () => validateRequestedItems([{ variant_id: 'x', quantity: 1 }]),
    error => error.statusCode === 400
  );
  assert.throws(
    () => validateRequestedItems([{ variant_id: '123', quantity: 101 }]),
    error => error.statusCode === 400
  );
});

test('formats fixed discounts for the entire line quantity', () => {
  const lineItem = buildDraftOrderLineItem({
    variantId: '100',
    quantity: 2,
    currency: 'USD',
    shopCurrency: 'USD',
    discountPercent: 12,
    unitDiscountAmount: 13.2,
    shopUnitDiscountAmount: 13.2,
    isGift: false
  });

  assert.equal(lineItem.appliedDiscount.value, 13.2);
  assert.deepEqual(lineItem.appliedDiscount.amountWithCurrency, {
    amount: '26.40',
    currencyCode: 'USD'
  });
});

test('handler uses proxy customer and Shopify authoritative price', async () => {
  const originalFetch = global.fetch;
  let capturedDraftInput;
  global.fetch = async (url, options) => {
    const request = JSON.parse(options.body);

    if (request.query.includes('query CheckoutContext')) {
      return mockFetchResponse({
        data: {
          shop: { currencyCode: 'USD' },
          customer: {
            id: 'gid://shopify/Customer/12345',
            tags: ['DIAMOND'],
            amountSpent: { amount: '0', currencyCode: 'USD' },
            totalSpentMetafield: { value: '0' }
          },
          variants: [{
            id: 'gid://shopify/ProductVariant/100',
            price: '100',
            compareAtPrice: '110',
            contextualPricing: {
              price: { amount: '100', currencyCode: 'USD' },
              compareAtPrice: { amount: '110', currencyCode: 'USD' }
            },
            product: {
              tags: [],
              collections: { nodes: [{ handle: 'all-products' }] }
            }
          }]
        }
      });
    }

    capturedDraftInput = request.variables.input;
    return mockFetchResponse({
      data: {
        draftOrderCreate: {
          draftOrder: {
            id: 'gid://shopify/DraftOrder/1',
            legacyResourceId: '1',
            invoiceUrl: 'https://example.test/invoice',
            presentmentCurrencyCode: 'USD',
            totalPriceSet: {
              presentmentMoney: { amount: '86.80', currencyCode: 'USD' }
            }
          },
          userErrors: []
        }
      }
    });
  };

  try {
    const req = {
      method: 'POST',
      headers: { origin: 'https://example.test' },
      query: createSignedQuery(),
      body: {
        customer_id: '99999',
        currency: 'USD',
        country: 'US',
        items: [{
          variant_id: '100',
          quantity: 1,
          price: 0,
          discount_percent: 100
        }]
      }
    };
    const res = createMockResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.security_mode, 'app_proxy');
    assert.equal(
      capturedDraftInput.purchasingEntity.customerId,
      'gid://shopify/Customer/12345'
    );
    assert.equal(capturedDraftInput.lineItems[0].appliedDiscount.value, 13.2);
    assert.equal(
      capturedDraftInput.lineItems[0].appliedDiscount.amountWithCurrency.amount,
      '13.20'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('handler rejects requests that did not pass through App Proxy', async () => {
  const req = {
    method: 'POST',
    headers: {},
    query: {},
    body: {
      currency: 'USD',
      country: 'US',
      items: [{ variant_id: '100', quantity: 1 }]
    }
  };
  const res = createMockResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'A valid Shopify App Proxy request is required');
});

function mockFetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      return this;
    }
  };
}
