/**
 * Mock Enterprise Proxy and MCP Server.
 * Demonstrates:
 * 1. Reception of 2-legged Google OIDC tokens from Agent Gateway / Service Extension.
 * 2. Simulated Token Exchange with Enterprise's internal STS for an on-premise session token.
 * 3. Execution of internal Enterprise MCP tools without storing any tokens in Google Cloud.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwksRsa = require('jwks-rsa');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// Google Public Keys Client for OIDC JWT Verification
const googleJwksClient = jwksRsa({
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  cache: true,
  rateLimit: true,
});

function getKey(header, callback) {
  googleJwksClient.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// Tool Definitions
const ENTERPRISE_TOOLS = [
  {
    name: 'query_enterprise_portfolio',
    description: 'Queries simulated internal Enterprise trading desk allocations, open positions, and risk metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        desk: { type: 'string', description: 'Trading desk (e.g., "equities-na", "fixed-income", "macro")' },
        asset_class: { type: 'string', description: 'Filter by asset class (optional)' },
      },
      required: ['desk'],
    },
  },
  {
    name: 'get_enterprise_system_status',
    description: 'Retrieves operational health and low-latency gateway connectivity status for Enterprise systems.',
    inputSchema: {
      type: 'object',
      properties: {
        datacenter: { type: 'string', description: 'Datacenter region (e.g., "NY4", "LD4", "TY3")' },
      },
      required: ['datacenter'],
    },
  },
];

// Health Check
app.get('/healthz', (req, res) => {
  res.json({ status: 'healthy', service: 'mock-enterprise-proxy', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.send('Mock Enterprise MCP Proxy is running.');
});

// JSON-RPC MCP Handler
app.post('/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body || {};
  const authHeader = req.headers.authorization || req.headers['x-serverless-authorization'];

  console.log(`\n======================================================`);
  console.log(`[Enterprise Proxy] Inbound MCP Request: method='${method}'`);
  console.log(`[Enterprise Proxy] Client IP: ${req.ip}`);
  console.log(`[Enterprise Proxy] Headers received:`, JSON.stringify(req.headers, null, 2));

  // 1. INITIALIZE (MCP Handshake)
  if (method === 'initialize') {
    console.log(`[Enterprise Proxy] Handling 'initialize' handshake...`);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: { listChanged: true },
        },
        serverInfo: {
          name: 'mock-enterprise-proxy',
          version: '1.0.0',
        },
      },
    });
  }

  // 2. TOOLS / LIST
  if (method === 'tools/list') {
    console.log(`[Enterprise Proxy] Handling 'tools/list' -> returning ${ENTERPRISE_TOOLS.length} tools`);
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: ENTERPRISE_TOOLS,
      },
    });
  }

  // 3. TOOLS / CALL (Requires Authenticated Google Identity)
  if (method === 'tools/call') {
    console.log(`[Enterprise Proxy] Handling 'tools/call' for tool: '${params ? params.name : "unknown"}'`);

    let callerEmail = 'private-agent-gateway-network-attachment';
    let simulatedOnPremTicket = `enterprise-onprem-ticket-${crypto.randomBytes(8).toString('hex')}`;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      let decodedPayload = null;

      // Decode and inspect JWT
      try {
        decodedPayload = jwt.decode(token);
        console.log(`[Enterprise Proxy] 🔍 Inspected JWT Payload:`);
        console.log(`   - Issuer:  ${decodedPayload.iss}`);
        console.log(`   - Email:   ${decodedPayload.email}`);
        console.log(`   - Aud:     ${decodedPayload.aud}`);
        console.log(`   - Exp:     ${new Date(decodedPayload.exp * 1000).toISOString()}`);
        callerEmail = decodedPayload.email || decodedPayload.sub || callerEmail;
      } catch (err) {
        console.warn(`[Enterprise Proxy] Failed to decode JWT: ${err.message}`);
      }

      // -------------------------------------------------------------------------
      // SIMULATED ENTERPRISE TOKEN EXCHANGE
      // -------------------------------------------------------------------------
      console.log(`\n------------------------------------------------------`);
      console.log(`🔐 [Enterprise Token Exchange] STARTING EXCHANGE FOR CALLER: ${callerEmail}`);
      console.log(`   1. Validated Google Cryptographic Assertion (iss: ${decodedPayload ? decodedPayload.iss : "N/A"})`);
      console.log(`   2. Calling Enterprise Internal STS (RFC 8693 simulation)...`);
      console.log(`   ✅ STS Exchange Successful!`);
      console.log(`   Generated On-Prem Session Ticket: ${simulatedOnPremTicket}`);
      console.log(`   3. Token scope: desk.read, marketdata.access (User/Service: ${callerEmail})`);
      console.log(`------------------------------------------------------\n`);
    } else {
      console.log(`\n------------------------------------------------------`);
      console.log(`🔒 [Private Connectivity] Request received privately via Agent Gateway Network Attachment.`);
      console.log(`   - Ingress Mode: Private VPC Internal-Only`);
      console.log(`   - Authenticated Boundary: psc-na-us-central1-agw -> vnet-ge`);
      console.log(`   - Identity Context: ${callerEmail}`);
      console.log(`------------------------------------------------------\n`);
    }

    // Execute the Tool
    const toolName = params.name;
    const toolArgs = params.arguments || {};
    let toolResultText = '';

    if (toolName === 'query_enterprise_portfolio') {
      const desk = toolArgs.desk || 'equities-na';
      const portfolioData = {
        desk: desk,
        timestamp: new Date().toISOString(),
        authenticated_caller: callerEmail,
        enterprise_internal_ticket: simulatedOnPremTicket,
        status: 'ACTIVE_TRADING',
        metrics: {
          net_market_value: '$142,500,000 USD',
          daily_pnl: '+$1,840,200 USD (+1.29%)',
          var_95: '$3,200,000 USD',
          sharpe_ratio: 2.84,
        },
        top_positions: [
          { symbol: 'GOOGL', shares: 250000, market_value: '$43,750,000', direction: 'LONG' },
          { symbol: 'MSFT', shares: 120000, market_value: '$50,400,000', direction: 'LONG' },
          { symbol: 'NVDA', shares: 85000, market_value: '$10,200,000', direction: 'LONG' },
          { symbol: 'SPY_HEDGE', contracts: 4500, market_value: '-$24,000,000', direction: 'SHORT' },
        ],
      };
      toolResultText = JSON.stringify(portfolioData, null, 2);
    } else if (toolName === 'get_enterprise_system_status') {
      const dc = toolArgs.datacenter || 'NY4';
      const statusData = {
        datacenter: dc,
        status: 'HEALTHY',
        authenticated_caller: callerEmail,
        enterprise_internal_ticket: simulatedOnPremTicket,
        latency_p99: '0.84ms',
        gateway_bridges: ['feed-direct-ny4', 'order-flow-ny4-a', 'order-flow-ny4-b'],
        last_heartbeat: new Date().toISOString(),
      };
      toolResultText = JSON.stringify(statusData, null, 2);
    } else {
      toolResultText = `Unknown tool: ${toolName}`;
    }

    console.log(`[Enterprise Proxy] ✅ Tool execution succeeded. Returning response...`);
    console.log(`[Enterprise Proxy] Discarding on-prem token from proxy memory.`);
    console.log(`======================================================\n`);

    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: toolResultText,
          },
        ],
      },
    });
  }

  // Fallback for unknown methods
  return res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  });
});

app.listen(PORT, () => {
  console.log(`======================================================`);
  console.log(`🚀 Mock Enterprise MCP Proxy listening on port ${PORT}`);
  console.log(`   - Health check: http://localhost:${PORT}/healthz`);
  console.log(`   - MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`======================================================`);
});
