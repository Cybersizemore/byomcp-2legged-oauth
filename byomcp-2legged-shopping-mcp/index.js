/**
 * Sample Downstream Okta-Gated Shopping MCP Server (byomcp-2legged-shopping-mcp)
 *
 * Architecture Role:
 * 1. Separate MCP server deployed on Cloud Run (or Private GKE) with --ingress=internal.
 * 2. Strictly rejects any request that does not carry a valid Okta Access Token.
 * 3. Cryptographically verifies the Okta JWT against Okta's public JWKS (/v1/keys),
 *    checking signature, issuer (iss), audience (aud), expiration (exp), and scope (mcp.tools).
 * 4. Executes enterprise Shopping tools and returns cryptographic proof of the verified Okta claims.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const app = express();
app.use(express.json());

// ============================================================================
// OKTA VERIFICATION CONFIGURATION
// ============================================================================
const OKTA_ISSUER =
  process.env.OKTA_ISSUER || 'https://YOUR_OKTA_DOMAIN.okta.com/oauth2/YOUR_AUTH_SERVER_ID';
const OKTA_AUDIENCE = process.env.OKTA_AUDIENCE || 'api://enterprise-mcp';
const REQUIRED_SCOPE = process.env.REQUIRED_SCOPE || 'mcp.tools';

// JWKS client fetches public signing keys directly from Okta's /v1/keys endpoint
const client = jwksClient({
  jwksUri: `${OKTA_ISSUER}/v1/keys`,
  cache: true,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getOktaSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

function verifyOktaToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getOktaSigningKey,
      {
        algorithms: ['RS256'],
        issuer: OKTA_ISSUER,
        audience: OKTA_AUDIENCE,
      },
      (err, decoded) => {
        if (err) return reject(err);
        const scopes = Array.isArray(decoded.scp) ? decoded.scp : [];
        if (REQUIRED_SCOPE && !scopes.includes(REQUIRED_SCOPE)) {
          return reject(
            new Error(
              `Missing required Okta scope '${REQUIRED_SCOPE}'. Token scopes: ${scopes.join(', ')}`
            )
          );
        }
        resolve(decoded);
      }
    );
  });
}

// ============================================================================
// SHOPPING MCP TOOLS CATALOG (Protected by Okta JWT)
// ============================================================================
const SHOPPING_TOOLS = [
  {
    name: 'search_shopping_catalog',
    description:
      'Searches the Enterprise Retail Shopping Catalog for products, pricing, and member promotions (Requires valid Okta Access Token).',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          description:
            "Shopping category to search (e.g., 'electronics', 'apparel', 'home', 'footwear').",
        },
        max_price: {
          type: 'number',
          description: 'Optional maximum price filter in USD.',
        },
      },
      required: ['category'],
    },
  },
  {
    name: 'get_shopping_order_status',
    description:
      'Retrieves real-time customer shopping order status, carrier tracking, and delivery ETA (Requires valid Okta Access Token).',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: "The customer order ID (e.g., 'ORD-90210', 'ORD-10455').",
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'check_store_inventory',
    description:
      'Checks live warehouse and retail store inventory levels for a specific shopping item or SKU (Requires valid Okta Access Token).',
    inputSchema: {
      type: 'object',
      properties: {
        sku: {
          type: 'string',
          description:
            "Product SKU or item name (e.g., 'SKU-PIXEL-WATCH', 'SKU-HEADPHONES-PRO', 'SKU-ESPRESSO-MAX').",
        },
      },
      required: ['sku'],
    },
  },
];

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/healthz', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'byomcp-2legged-shopping-mcp',
    role: 'Downstream Okta-Gated Shopping MCP Server',
    okta_issuer: OKTA_ISSUER,
    okta_audience: OKTA_AUDIENCE,
    required_scope: REQUIRED_SCOPE,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.send('byomcp-2legged-shopping-mcp is running and gated by Okta JWT verification.');
});

// ============================================================================
// OKTA-GATED MCP ENDPOINT (/mcp)
// ============================================================================
app.post('/mcp', async (req, res) => {
  const { method, id, params } = req.body || {};
  const authHeader =
    req.headers['x-enterprise-okta-authorization'] || req.headers.authorization || '';
  const callerGoogleSa = req.headers['x-verified-google-caller'] || 'unknown';

  console.log(`\n======================================================`);
  console.log(`🛍️  [byomcp-2legged-shopping-mcp] Inbound MCP Request: method='${method}'`);

  // STRICT OKTA GATE: Reject any call that does not carry a valid Okta Bearer JWT
  if (!authHeader.startsWith('Bearer ')) {
    console.warn(`❌ [byomcp-2legged-shopping-mcp] Missing Okta Authorization token`);
    return res.status(401).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32001,
        message: 'Unauthorized: Missing Okta token on byomcp-2legged-shopping-mcp',
      },
    });
  }

  const token = authHeader.split(' ')[1];
  let oktaClaims;
  try {
    oktaClaims = await verifyOktaToken(token);
    console.log(`✅ [byomcp-2legged-shopping-mcp] Cryptographically Verified Okta Token!`);
    console.log(`   - Okta Issuer (iss):    ${oktaClaims.iss}`);
    console.log(`   - Okta Audience (aud):  ${oktaClaims.aud}`);
    console.log(`   - Okta Client ID (cid): ${oktaClaims.cid}`);
    console.log(`   - Okta Subject (sub):   ${oktaClaims.sub}`);
    console.log(`   - Okta Scopes (scp):    ${JSON.stringify(oktaClaims.scp)}`);
    console.log(`   - Okta Token ID (jti):  ${oktaClaims.jti}`);
  } catch (err) {
    console.error(`❌ [byomcp-2legged-shopping-mcp] Rejected token: ${err.message}`);
    return res.status(403).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32002,
        message: `Forbidden by Okta Gate: byomcp-2legged-shopping-mcp only accepts valid Okta tokens (${err.message})`,
      },
    });
  }

  // 1. INITIALIZE
  if (method === 'initialize') {
    const requestedVersion = params?.protocolVersion || '2024-11-05';
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requestedVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: {
          name: 'byomcp-2legged-shopping-mcp',
          version: '2.0.0',
        },
      },
    });
  }

  // 1b. NOTIFICATIONS/INITIALIZED & PING
  if (method === 'notifications/initialized' || method === 'initialized' || method === 'ping') {
    return res.status(200).json({
      jsonrpc: '2.0',
      id: id ?? null,
      result: {},
    });
  }

  // 2. TOOLS / LIST
  if (method === 'tools/list') {
    console.log(`🛍️  [byomcp-2legged-shopping-mcp] Returning ${SHOPPING_TOOLS.length} shopping tools`);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: SHOPPING_TOOLS,
      },
    });
  }

  // 3. TOOLS / CALL
  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    const authProof = {
      service_name: 'byomcp-2legged-shopping-mcp',
      verified_google_service_extension_sa: callerGoogleSa,
      okta_issuer: oktaClaims.iss,
      okta_audience: oktaClaims.aud,
      okta_client_id: oktaClaims.cid,
      okta_subject: oktaClaims.sub,
      okta_scopes: oktaClaims.scp,
      okta_token_jti: oktaClaims.jti,
      okta_token_exp: new Date(oktaClaims.exp * 1000).toISOString(),
    };

    if (toolName === 'search_shopping_catalog') {
      const category = (toolArgs.category || 'electronics').toLowerCase();
      const maxPrice = toolArgs.max_price || 2000;

      const catalogs = {
        electronics: [
          { sku: 'SKU-HEADPHONES-PRO', name: 'Studio Noise-Canceling Headphones Pro', price_usd: 299.99, rating: 4.9, promo: '15% Member Discount' },
          { sku: 'SKU-PIXEL-WATCH', name: 'Smart Fitness Watch LTE', price_usd: 349.00, rating: 4.8, promo: 'Free Sport Band Included' },
          { sku: 'SKU-4K-MONITOR', name: 'UltraWide 34-inch 4K USB-C Hub Monitor', price_usd: 649.00, rating: 4.7, promo: 'Free Next-Day Shipping' },
        ],
        home: [
          { sku: 'SKU-ESPRESSO-MAX', name: 'Barista Dual-Boiler Espresso Machine', price_usd: 599.00, rating: 4.9, promo: '$100 Gift Card Bundle' },
          { sku: 'SKU-ROBO-VAC', name: 'LiDAR Smart Robot Vacuum & Mop', price_usd: 429.00, rating: 4.6, promo: '20% Off' },
        ],
        apparel: [
          { sku: 'SKU-PARKA-01', name: 'Waterproof Alpine Down Parka', price_usd: 245.00, rating: 4.8, promo: 'Buy 1 Get 1 30% Off Accessories' },
          { sku: 'SKU-MERINO-CREW', name: '100% Merino Wool Travel Crewneck', price_usd: 98.00, rating: 4.7, promo: 'In Stock' },
        ],
      };

      const items = (catalogs[category] || catalogs.electronics).filter((i) => i.price_usd <= maxPrice);

      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'SUCCESS',
                  okta_auth_proof: authProof,
                  shopping_search_results: {
                    category,
                    max_price_filter_usd: maxPrice,
                    matching_items_count: items.length,
                    items,
                  },
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }

    if (toolName === 'get_shopping_order_status') {
      const orderId = toolArgs.order_id || 'ORD-90210';
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'SUCCESS',
                  okta_auth_proof: authProof,
                  order_tracking: {
                    order_id: orderId,
                    order_status: 'OUT_FOR_DELIVERY',
                    carrier: 'UPS Next Day Air',
                    tracking_number: '1Z999AA10123456784',
                    estimated_delivery: 'Today by 4:30 PM',
                    items: [
                      { sku: 'SKU-HEADPHONES-PRO', name: 'Studio Noise-Canceling Headphones Pro', qty: 1, price_usd: 299.99 },
                      { sku: 'SKU-ESPRESSO-MAX', name: 'Barista Dual-Boiler Espresso Machine', qty: 1, price_usd: 599.00 },
                    ],
                    total_charged_usd: 898.99,
                  },
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }

    if (toolName === 'check_store_inventory') {
      const sku = toolArgs.sku || 'SKU-HEADPHONES-PRO';
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'SUCCESS',
                  okta_auth_proof: authProof,
                  inventory_lookup: {
                    sku,
                    online_warehouse_stock: 142,
                    flagship_stores: [
                      { store: 'Chicago Michigan Ave', stock_on_hand: 18, aisle: 'Aisle 4 - Audio & Tech' },
                      { store: 'New York SoHo', stock_on_hand: 24, aisle: 'Floor 2 - Featured Gear' },
                      { store: 'Austin Domain', stock_on_hand: 9, aisle: 'Aisle 2 - Smart Devices' },
                    ],
                    same_day_pickup_eligible: true,
                  },
                },
                null,
                2
              ),
            },
          ],
        },
      });
    }

    return res.status(400).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown shopping tool: ${toolName}` },
    });
  }

  return res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🛍️  [byomcp-2legged-shopping-mcp] Listening on port ${PORT}`);
  console.log(`🔐 Gated by Okta JWKS: ${OKTA_ISSUER}/v1/keys`);
});
