# Helios Tier Pricing API

Backend API for creating Shopify draft orders with line item discounts.

## Endpoint

### POST /api/create-draft-order

Create a draft order with line item discounts based on customer tier.

#### Request Body

```json
{
  "customer_id": "123456789",
  "customer_email": "customer@example.com",
  "items": [
    {
      "variant_id": "987654321",
      "quantity": 2,
      "price": 100.00,
      "discount_percent": 15
    }
  ]
}
```

#### Parameters

- `customer_id` (optional) - Shopify customer ID
- `customer_email` (optional) - Customer email (required if no customer_id)
- `items` (required) - Array of line items
  - `variant_id` (required) - Shopify variant ID
  - `quantity` (required) - Quantity
  - `price` (required) - Original price in dollars
  - `discount_percent` (required) - Discount percentage (0-100)

#### Response

**Success (200)**
```json
{
  "success": true,
  "draft_order_id": "123456789",
  "invoice_url": "https://your-store.myshopify.com/...",
  "total_price": "170.00"
}
```

**Error (400/500)**
```json
{
  "error": "Error message"
}
```

## Environment Variables

Required in Vercel:

- `SHOPIFY_SHOP` - Your Shopify store domain (e.g., `your-store.myshopify.com`)
- `SHOPIFY_ACCESS_TOKEN` - Admin API access token with `write_draft_orders` scope

## Local Development

```bash
# Install dependencies
npm install

# Run local dev server
vercel dev

# Test endpoint
curl -X POST http://localhost:3000/api/create-draft-order \
  -H "Content-Type: application/json" \
  -d @test-request.json
```

## Deployment

```bash
# Deploy to production
vercel --prod
```

## How It Works

1. Receives cart items with discount percentages
2. Calculates discounted prices for each line item
3. Creates draft order via Shopify Admin API
4. Returns invoice URL for customer to complete payment

## Notes

- Line item discounts are applied directly (not via discount codes)
- Draft orders expire after 30 days
- Customer must pay via invoice URL
- Supports both customer ID and email lookup
