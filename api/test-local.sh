#!/bin/bash

# Test local API endpoint
# Usage: ./test-local.sh

echo "Testing local API endpoint..."
echo ""

curl -X POST http://localhost:3000/api/create-draft-order \
  -H "Content-Type: application/json" \
  -d @api/test-request.json \
  | json_pp

echo ""
echo "Done!"
