'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SHOPIFY_SHOP = 'helios-global.myshopify.com';
process.env.SHOPIFY_ACCESS_TOKEN = 'test-token';
process.env.DISABLE_LEGACY_ENDPOINT = 'true';

const handler = require('../api/create-draft-order');

test('legacy draft order endpoint can be disabled after migration', async () => {
  const req = {
    method: 'POST',
    body: {
      customer_id: '12345',
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

  assert.equal(res.statusCode, 410);
  assert.equal(res.body.error, 'Legacy draft order endpoint is disabled');
});

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
