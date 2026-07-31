'use strict';

const DEFAULT_TIERS = [
  {
    name: 'BLACK DIAMOND',
    tag: 'BLACK DIAMOND',
    discount: 15,
    threshold: 20000
  },
  {
    name: 'DIAMOND',
    tag: 'DIAMOND',
    discount: 12,
    threshold: 3500
  },
  {
    name: 'PLATINUM',
    tag: 'PLATINUM',
    discount: 10,
    threshold: 1500
  },
  {
    name: 'GOLD',
    tag: 'GOLD',
    discount: 8,
    threshold: 500
  },
  {
    name: 'SILVER',
    tag: 'SILVER',
    discount: 5,
    threshold: 250
  },
  {
    name: 'MEMBER',
    tag: '',
    discount: 0,
    threshold: 0
  }
];

function getTierPolicy(env = process.env) {
  const configuredTiers = parseJson(env.TIER_CONFIG_JSON, DEFAULT_TIERS);
  const tiers = Array.isArray(configuredTiers)
    ? configuredTiers.map(normalizeTier).filter(Boolean)
    : DEFAULT_TIERS.map(normalizeTier);

  if (tiers.length === 0) {
    throw new Error('TIER_CONFIG_JSON must contain at least one valid tier');
  }

  return {
    tiers,
    prioritizeTags: parseBoolean(env.TIER_PRIORITIZE_TAGS, true),
    scope: normalizeScope(env.TIER_PRICING_SCOPE || 'all'),
    allowedTags: parseList(env.TIER_PRICING_PRODUCT_TAGS),
    allowedCollections: parseList(env.TIER_PRICING_COLLECTION_HANDLES),
    gift: {
      enabled: parseBoolean(env.FREE_GIFT_ENABLED, false),
      variantIds: parseList(env.FREE_GIFT_VARIANT_IDS),
      triggerCollection: normalizeText(
        env.FREE_GIFT_TRIGGER_COLLECTION || 'all-products'
      ),
      minimums: normalizeMinimums(
        parseJson(env.FREE_GIFT_MINIMUMS_JSON, { USD: 0 })
      )
    }
  };
}

function buildAuthoritativeItems({
  requestedItems,
  variantsById,
  customer,
  currency,
  shopCurrency = currency,
  policy
}) {
  const tier = resolveCustomerTier(customer, policy);
  const preparedItems = requestedItems.map((requestedItem, index) => {
    const variantId = normalizeNumericId(requestedItem.variant_id);
    const variant = variantsById.get(variantId);

    if (!variant) {
      throw clientError(400, `Item ${index}: variant was not found`);
    }

    const contextualPrice = variant.contextualPricing &&
      variant.contextualPricing.price;
    const contextualCompareAt = variant.contextualPricing &&
      variant.contextualPricing.compareAtPrice;
    const priceCurrency = contextualPrice &&
      String(contextualPrice.currencyCode || '').toUpperCase();
    const price = Number(contextualPrice && contextualPrice.amount);
    const compareAtPrice = Number(
      contextualCompareAt && contextualCompareAt.amount
    );
    const shopPrice = Number(variant.price);
    const shopCompareAtPrice = Number(variant.compareAtPrice);

    if (priceCurrency !== currency) {
      throw clientError(
        409,
        `Item ${index}: Shopify market currency is ${priceCurrency || 'unknown'}, not ${currency}`
      );
    }
    if (
      contextualCompareAt &&
      String(contextualCompareAt.currencyCode || '').toUpperCase() !== currency
    ) {
      throw clientError(
        409,
        `Item ${index}: Shopify returned mismatched compare-at currency`
      );
    }
    if (!Number.isFinite(price) || price < 0) {
      throw clientError(422, `Item ${index}: Shopify returned an invalid price`);
    }
    if (!Number.isFinite(shopPrice) || shopPrice < 0) {
      throw clientError(
        422,
        `Item ${index}: Shopify returned an invalid shop price`
      );
    }

    const product = variant.product || {};
    const productTags = Array.isArray(product.tags) ? product.tags : [];
    const collectionHandles = product.collections &&
      Array.isArray(product.collections.nodes)
      ? product.collections.nodes.map(collection => collection.handle)
      : [];

    return {
      variantId,
      quantity: Number(requestedItem.quantity),
      price,
      compareAtPrice: Number.isFinite(compareAtPrice) ? compareAtPrice : 0,
      shopPrice,
      shopCompareAtPrice: Number.isFinite(shopCompareAtPrice)
        ? shopCompareAtPrice
        : 0,
      productTags,
      collectionHandles,
      tier,
      discountPercent: resolveProductDiscount(
        tier,
        productTags,
        collectionHandles,
        policy
      ),
      isGiftCandidate: policy.gift.enabled &&
        policy.gift.variantIds.includes(variantId)
    };
  });

  const giftEligibility = calculateGiftEligibility(
    preparedItems,
    currency,
    policy
  );

  return preparedItems.map((item, index) => {
    let discountPercent = item.discountPercent;
    let isGift = false;

    if (item.isGiftCandidate) {
      if (item.quantity !== 1) {
        throw clientError(
          400,
          `Item ${index}: a free gift must have quantity 1`
        );
      }
      if (!giftEligibility) {
        throw clientError(
          400,
          `Item ${index}: the free gift requirements are not met`
        );
      }
      discountPercent = 100;
      isGift = true;
    }

    const discountBase = item.compareAtPrice > item.price
      ? item.compareAtPrice
      : item.price;
    const shopDiscountBase = item.shopCompareAtPrice > item.shopPrice
      ? item.shopCompareAtPrice
      : item.shopPrice;
    const unitDiscountAmount = roundCurrency(
      Math.min(
        item.price,
        Math.max(0, discountBase * discountPercent / 100)
      ),
      currency
    );
    const shopUnitDiscountAmount = roundCurrency(
      Math.min(
        item.shopPrice,
        Math.max(0, shopDiscountBase * discountPercent / 100)
      ),
      shopCurrency
    );

    return {
      variantId: item.variantId,
      quantity: item.quantity,
      price: item.price,
      currency,
      shopCurrency,
      tierName: item.tier.name,
      discountPercent,
      unitDiscountAmount,
      shopUnitDiscountAmount,
      isGift
    };
  });
}

function resolveCustomerTier(customer, policy) {
  const tags = new Set(
    (customer.tags || []).map(tag => normalizeText(tag))
  );

  if (policy.prioritizeTags) {
    const taggedTier = policy.tiers.find(tier =>
      tier.tag && tags.has(normalizeText(tier.tag))
    );
    if (taggedTier) {
      return taggedTier;
    }
  }

  const totalSpent = getCustomerTotalSpent(customer);
  return policy.tiers.find(tier => totalSpent >= tier.threshold) ||
    policy.tiers[policy.tiers.length - 1];
}

function resolveProductDiscount(
  tier,
  productTags,
  collectionHandles,
  policy
) {
  const tierTagPrefix = `tier-${normalizeTierName(tier.name)}-`;

  for (const productTag of productTags) {
    const normalizedTag = normalizeText(productTag);
    if (!normalizedTag.startsWith(tierTagPrefix)) {
      continue;
    }

    const percent = Number(normalizedTag.slice(tierTagPrefix.length));
    if (Number.isFinite(percent) && percent > 0 && percent <= 100) {
      return percent;
    }
  }

  if (!tierPricingApplies(productTags, collectionHandles, policy)) {
    return 0;
  }

  return tier.discount;
}

function tierPricingApplies(productTags, collectionHandles, policy) {
  const tags = productTags.map(normalizeText);
  const collections = collectionHandles.map(normalizeText);

  if (policy.scope === 'all') {
    return true;
  }
  if (policy.scope === 'tagged') {
    return policy.allowedTags.some(tag => tags.includes(tag));
  }
  if (policy.scope === 'collections') {
    return policy.allowedCollections.some(handle =>
      collections.includes(handle)
    );
  }
  if (policy.scope === 'exclude_tagged') {
    return !policy.allowedTags.some(tag => tags.includes(tag));
  }

  return false;
}

function calculateGiftEligibility(items, currency, policy) {
  if (!policy.gift.enabled || !items.some(item => item.isGiftCandidate)) {
    return false;
  }

  const minimum = Number(policy.gift.minimums[currency]);
  if (!Number.isFinite(minimum) || minimum < 0) {
    return false;
  }

  const qualifyingSubtotal = items
    .filter(item => {
      if (item.isGiftCandidate) {
        return false;
      }
      if (!policy.gift.triggerCollection) {
        return true;
      }
      return item.collectionHandles
        .map(normalizeText)
        .includes(policy.gift.triggerCollection);
    })
    .reduce((total, item) => total + item.price * item.quantity, 0);

  return qualifyingSubtotal >= minimum;
}

function getCustomerTotalSpent(customer) {
  const metafield = customer.totalSpentMetafield;
  if (
    metafield &&
    metafield.value !== null &&
    metafield.value !== undefined &&
    String(metafield.value).trim() !== ''
  ) {
    const metafieldValue = Number(metafield.value);
    if (Number.isFinite(metafieldValue) && metafieldValue >= 0) {
      return metafieldValue;
    }
  }

  const amountSpent = Number(customer.amountSpent?.amount);
  return Number.isFinite(amountSpent) && amountSpent >= 0 ? amountSpent : 0;
}

function normalizeTier(tier) {
  if (!tier || !tier.name) {
    return null;
  }

  const discount = Number(tier.discount);
  const threshold = Number(tier.threshold);
  if (
    !Number.isFinite(discount) ||
    discount < 0 ||
    discount > 100 ||
    !Number.isFinite(threshold) ||
    threshold < 0
  ) {
    return null;
  }

  return {
    name: String(tier.name).trim(),
    tag: String(tier.tag || '').trim(),
    discount,
    threshold
  };
}

function normalizeScope(value) {
  const scope = String(value || '').trim().toLowerCase();
  return ['all', 'tagged', 'collections', 'exclude_tagged'].includes(scope)
    ? scope
    : 'all';
}

function normalizeMinimums(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((result, [currency, minimum]) => {
    const normalizedCurrency = String(currency).trim().toUpperCase();
    const normalizedMinimum = Number(minimum);
    if (
      /^[A-Z]{3}$/.test(normalizedCurrency) &&
      Number.isFinite(normalizedMinimum) &&
      normalizedMinimum >= 0
    ) {
      result[normalizedCurrency] = normalizedMinimum;
    }
    return result;
  }, {});
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(normalizeText)
    .filter(Boolean);
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON environment configuration: ${error.message}`);
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value).trim().toLowerCase() === 'true';
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTierName(value) {
  return normalizeText(value).replace(/[\s_]+/g, '');
}

function normalizeNumericId(value) {
  const normalized = String(value || '')
    .replace('gid://shopify/ProductVariant/', '')
    .trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function roundCurrency(value, currency) {
  const zeroDecimalCurrencies = new Set([
    'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW',
    'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'
  ]);
  const threeDecimalCurrencies = new Set([
    'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND'
  ]);
  const precision = zeroDecimalCurrencies.has(currency)
    ? 0
    : threeDecimalCurrencies.has(currency)
      ? 3
      : 2;
  const scale = Math.pow(10, precision);
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function clientError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  DEFAULT_TIERS,
  buildAuthoritativeItems,
  getTierPolicy,
  normalizeNumericId,
  resolveCustomerTier,
  resolveProductDiscount
};
