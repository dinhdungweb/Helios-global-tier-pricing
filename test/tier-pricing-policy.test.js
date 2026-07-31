'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildAuthoritativeItems,
  getTierPolicy,
  resolveCustomerTier
} = require('../lib/tier-pricing-policy');

function createVariant({
  id = '100',
  price = '100',
  compareAtPrice = '110',
  shopPrice = price,
  shopCompareAtPrice = compareAtPrice,
  currency = 'USD',
  tags = [],
  collections = ['all-products']
} = {}) {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    price: shopPrice,
    compareAtPrice: shopCompareAtPrice,
    contextualPricing: {
      price: { amount: price, currencyCode: currency },
      compareAtPrice: compareAtPrice === null
        ? null
        : { amount: compareAtPrice, currencyCode: currency }
    },
    product: {
      tags,
      collections: {
        nodes: collections.map(handle => ({ handle }))
      }
    }
  };
}

function createCustomer(tags = ['DIAMOND'], totalSpent = '0') {
  return {
    tags,
    totalSpentMetafield: { value: totalSpent },
    amountSpent: { amount: totalSpent, currencyCode: 'USD' }
  };
}

test('Global defaults match the active theme tier configuration', () => {
  const policy = getTierPolicy({});

  assert.equal(policy.tiers[0].name, 'BLACK DIAMOND');
  assert.equal(policy.tiers[0].discount, 15);
  assert.equal(policy.tiers[0].threshold, 20000);
  assert.equal(policy.tiers[4].name, 'SILVER');
  assert.equal(policy.tiers[4].discount, 5);
  assert.equal(policy.tiers[4].threshold, 250);
});

test('customer tags take priority over spend thresholds', () => {
  const policy = getTierPolicy({});
  const tier = resolveCustomerTier(createCustomer(['GOLD'], '30000'), policy);

  assert.equal(tier.name, 'GOLD');
  assert.equal(tier.discount, 8);
});

test('falls back to Shopify amount spent when the custom metafield is absent', () => {
  const policy = getTierPolicy({});
  const tier = resolveCustomerTier({
    tags: [],
    totalSpentMetafield: null,
    amountSpent: { amount: '419', currencyCode: 'USD' }
  }, policy);

  assert.equal(tier.name, 'SILVER');
  assert.equal(tier.discount, 5);
});

test('client price and discount fields cannot change authoritative pricing', () => {
  const variant = createVariant();
  const items = buildAuthoritativeItems({
    requestedItems: [{
      variant_id: '100',
      quantity: 1,
      price: 0,
      discount_percent: 100
    }],
    variantsById: new Map([['100', variant]]),
    customer: createCustomer(),
    currency: 'USD',
    shopCurrency: 'USD',
    policy: getTierPolicy({})
  });

  assert.equal(items[0].price, 100);
  assert.equal(items[0].discountPercent, 12);
  assert.equal(items[0].unitDiscountAmount, 13.2);
  assert.equal(items[0].isGift, false);
});

test('uses Shopify contextual pricing and active currency precision', () => {
  const usdVariant = createVariant();
  const jpyVariant = createVariant({
    id: '200',
    price: '1001',
    compareAtPrice: null,
    currency: 'JPY'
  });
  const policy = getTierPolicy({});

  const usdItems = buildAuthoritativeItems({
    requestedItems: [{ variant_id: '100', quantity: 1 }],
    variantsById: new Map([['100', usdVariant]]),
    customer: createCustomer(),
    currency: 'USD',
    policy
  });
  const jpyItems = buildAuthoritativeItems({
    requestedItems: [{ variant_id: '200', quantity: 1 }],
    variantsById: new Map([['200', jpyVariant]]),
    customer: createCustomer(),
    currency: 'JPY',
    policy
  });

  assert.equal(usdItems[0].unitDiscountAmount, 13.2);
  assert.equal(jpyItems[0].unitDiscountAmount, 120);
});

test('rejects a currency that differs from Shopify contextual pricing', () => {
  const variant = createVariant({ currency: 'USD' });

  assert.throws(() => buildAuthoritativeItems({
    requestedItems: [{ variant_id: '100', quantity: 1 }],
    variantsById: new Map([['100', variant]]),
    customer: createCustomer(),
    currency: 'EUR',
    policy: getTierPolicy({})
  }), error => error.statusCode === 409);
});
