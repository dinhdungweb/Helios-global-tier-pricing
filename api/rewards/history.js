/**
 * Rewards History API
 * Lấy lịch sử đổi điểm và điểm hiện tại của khách hàng
 * 
 * GET /api/rewards/history?customer_id=123456
 */

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = '2024-10';

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(500).json({
            error: 'Server configuration error',
            message: 'Missing environment variables'
        });
    }

    try {
        const { customer_id } = req.query;

        if (!customer_id) {
            return res.status(400).json({ error: 'customer_id is required' });
        }

        const numericId = customer_id.toString().replace(/\D/g, '');
        
        if (!numericId) {
            return res.status(400).json({ error: 'Invalid customer_id format' });
        }

        console.log('Fetching rewards history for customer:', numericId);

        // Lấy tất cả metafields của customer trong namespace rewards
        const apiUrl = `https://${SHOPIFY_SHOP}/admin/api/${API_VERSION}/customers/${numericId}/metafields.json?namespace=rewards`;
        console.log('API URL:', apiUrl);
        
        const response = await fetch(apiUrl, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
            }
        });

        console.log('Response status:', response.status);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Shopify API error:', errorText);
            
            if (response.status === 404) {
                return res.status(404).json({ error: 'Customer not found' });
            }
            
            return res.status(response.status).json({
                error: 'Shopify API error',
                status: response.status,
                details: errorText
            });
        }

        const data = await response.json();
        const metafields = data.metafields || [];

        // Tìm points và history
        const pointsMetafield = metafields.find(m => m.key === 'points');
        const historyMetafield = metafields.find(m => m.key === 'history');

        const points = pointsMetafield ? parseInt(pointsMetafield.value) || 0 : 0;

        let history = [];
        if (historyMetafield) {
            try {
                history = JSON.parse(historyMetafield.value);
            } catch (e) {
                console.error('Failed to parse history:', e);
                history = [];
            }
        }

        return res.status(200).json({
            success: true,
            customer_id: numericId,
            points: points,
            history: history
        });

    } catch (error) {
        console.error('❌ History error:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
};
