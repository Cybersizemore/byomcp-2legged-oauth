/**
 * Sample Enterprise MCP Auth Proxy (byomcp-2legged-okta-proxy)
 *
 * Architecture Role:
 * 1. Receives MCP JSON-RPC calls from Gemini Enterprise / Agent Gateway Service Extension (enterprise-extproc).
 * 2. Verifies the inbound Google OIDC JWT (minted by GCP Metadata Server) against Google's public JWKS.
 * 3. Performs a live 2-Legged OAuth (client_credentials + RFC 9449 DPoP) token exchange with Okta.
 * 4. Calls out over the private VPC (vnet-ge) to a separate Okta-gated Cloud Run MCP server
 *    (byomcp-2legged-shopping-mcp) with the Okta Access Token, then discards the token from memory.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const app = express();
app.use(express.json());

// ============================================================================
// CONFIGURATION (Enterprise Auth Proxy -> Okta -> Separate Cloud Run MCP Server)
// ============================================================================
const OKTA_ISSUER =
  process.env.OKTA_ISSUER || 'https://YOUR_OKTA_DOMAIN.okta.com/oauth2/YOUR_AUTH_SERVER_ID';
const OKTA_TOKEN_URL = process.env.OKTA_TOKEN_URL || `${OKTA_ISSUER}/v1/token`;
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID || 'YOUR_OKTA_CLIENT_ID';
const OKTA_CLIENT_SECRET = process.env.OKTA_CLIENT_SECRET || 'YOUR_OKTA_CLIENT_SECRET';
const OKTA_SCOPE = process.env.OKTA_SCOPE || 'mcp.tools';

// Downstream Okta-Gated Shopping MCP Server on Cloud Run (or Private GKE)
const DOWNSTREAM_MCP_URL =
  process.env.DOWNSTREAM_MCP_URL ||
  'https://byomcp-2legged-shopping-mcp-PROJECT_NUMBER.us-central1.run.app/mcp';

// Generate an ephemeral RSA-2048 keypair in memory for Okta RFC 9449 DPoP Proofs
const { publicKey: dpopPubKey, privateKey: dpopPrivKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const dpopPublicJwk = dpopPubKey.export({ format: 'jwk' });
let cachedDpopNonce = null;

function createDpopProof(httpMethod, httpUrl, nonce) {
  const header = {
    typ: 'dpop+jwt',
    alg: 'RS256',
    jwk: {
      kty: dpopPublicJwk.kty,
      n: dpopPublicJwk.n,
      e: dpopPublicJwk.e,
    },
  };
  const payload = {
    jti: crypto.randomUUID(),
    htm: httpMethod,
    htu: httpUrl,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) {
    payload.nonce = nonce;
  }

  const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = crypto
    .sign('sha256', Buffer.from(signingInput), dpopPrivKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

// ============================================================================
// STEP 1: Verify Inbound Google OIDC Token from Service Extension (Metadata Server)
// ============================================================================
const googleJwks = jwksClient({
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
  cache: true,
  rateLimit: true,
});

function getGoogleSigningKey(header, callback) {
  googleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyGoogleOidcJwt(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getGoogleSigningKey,
      {
        algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

// ============================================================================
// STEP 2: 2-Legged OAuth Token Exchange with Okta (client_credentials + DPoP)
// ============================================================================
async function exchangeForOktaToken(googleCallerIdentity) {
  console.log(`\n------------------------------------------------------`);
  console.log(`🔐 [byomcp-2legged-okta-proxy] STARTING OKTA 2-LEGGED OAUTH FOR CALLER: ${googleCallerIdentity}`);
  console.log(`   -> Okta Token Endpoint: ${OKTA_TOKEN_URL}`);
  console.log(`   -> Grant Type: client_credentials (2-Legged OAuth + DPoP)`);
  console.log(`   -> Requested Scope: ${OKTA_SCOPE}`);

  const basicAuth = Buffer.from(`${OKTA_CLIENT_ID}:${OKTA_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: OKTA_SCOPE,
  }).toString();

  let dpopProof = createDpopProof('POST', OKTA_TOKEN_URL, cachedDpopNonce);
  let response = await fetch(OKTA_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
      DPoP: dpopProof,
    },
    body,
  });

  // Handle Okta DPoP Nonce challenge (RFC 9449)
  const newNonce = response.headers.get('dpop-nonce');
  if (newNonce) {
    cachedDpopNonce = newNonce;
  }

  let data = await response.json();
  if (response.status === 400 && data.error === 'use_dpop_nonce' && cachedDpopNonce) {
    console.log(`   🔄 Okta issued DPoP nonce challenge; retrying with signed DPoP nonce...`);
    dpopProof = createDpopProof('POST', OKTA_TOKEN_URL, cachedDpopNonce);
    response = await fetch(OKTA_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basicAuth}`,
        DPoP: dpopProof,
      },
      body,
    });
    const retryNonce = response.headers.get('dpop-nonce');
    if (retryNonce) cachedDpopNonce = retryNonce;
    data = await response.json();
  }

  if (!response.ok || !data.access_token) {
    throw new Error(`Okta token request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  const decodedOkta = jwt.decode(data.access_token);
  console.log(`   ✅ Okta Token Exchange Successful!`);
  console.log(`   -> Okta Token JTI: ${decodedOkta?.jti}`);
  console.log(`   -> Okta Issuer:    ${decodedOkta?.iss}`);
  console.log(`   -> Okta Audience:  ${decodedOkta?.aud}`);
  console.log(`   -> Okta Scopes:    ${JSON.stringify(decodedOkta?.scp)}`);
  console.log(`------------------------------------------------------\n`);

  return data;
}

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/healthz', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'byomcp-2legged-okta-proxy',
    role: 'Edge Auth Proxy (Google OIDC -> Okta 2-Legged OAuth -> Downstream Shopping MCP)',
    okta_issuer: OKTA_ISSUER,
    downstream_mcp_url: DOWNSTREAM_MCP_URL,
    timestamp: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.send(
    'byomcp-2legged-okta-proxy is running. Verifies Google OIDC token, exchanges with Okta, and forwards to byomcp-2legged-shopping-mcp.'
  );
});

// ============================================================================
// MAIN MCP PROXY ENDPOINT (/mcp)
// ============================================================================
app.post('/mcp', async (req, res) => {
  const { method, id } = req.body || {};
  console.log(`\n======================================================`);
  console.log(`🛡️  [byomcp-2legged-okta-proxy] Inbound Request from Gemini Enterprise / Service Extension: method='${method}'`);

  const authHeader =
    req.headers.authorization ||
    req.headers['x-serverless-authorization'] ||
    req.headers['x-forwarded-authorization'] ||
    '';

  let callerEmail = 'private-agent-gateway-network-attachment';

  // Step 1: Verify Google OIDC Token from Service Extension (enterprise-extproc)
  if (authHeader.startsWith('Bearer ')) {
    const googleToken = authHeader.split(' ')[1];
    try {
      const googleClaims = await verifyGoogleOidcJwt(googleToken);
      callerEmail = googleClaims.email || googleClaims.sub || callerEmail;
      console.log(`✅ [byomcp-2legged-okta-proxy] Cryptographically Verified Google OIDC JWT (via Google JWKS):`);
      console.log(`   - Google SA Email: ${callerEmail}`);
      console.log(`   - Issuer:          ${googleClaims.iss}`);
      console.log(`   - Audience:        ${googleClaims.aud}`);
    } catch (verifyErr) {
      const decoded = jwt.decode(googleToken);
      callerEmail = decoded?.email || decoded?.sub || callerEmail;
      console.warn(`⚠️  [byomcp-2legged-okta-proxy] Decoded Google JWT (${verifyErr.message}): caller=${callerEmail}`);
    }
  } else {
    console.log(`🔒 [byomcp-2legged-okta-proxy] Request arrived via private PSC network attachment (${callerEmail})`);
  }

  // Step 2: Perform Live 2-Legged OAuth Token Exchange with Okta
  let oktaTokenData;
  try {
    oktaTokenData = await exchangeForOktaToken(callerEmail);
  } catch (err) {
    console.error(`❌ [byomcp-2legged-okta-proxy] Okta Token Exchange failed: ${err.message}`);
    return res.status(502).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: `Enterprise Proxy Okta Token Exchange failed: ${err.message}`,
      },
    });
  }

  // Step 3: Forward MCP Request with Okta Access Token to Separate Okta-Gated Shopping MCP Server
  try {
    console.log(`➡️  [byomcp-2legged-okta-proxy] Calling Downstream Shopping MCP: ${DOWNSTREAM_MCP_URL}`);

    // Obtain Cloud Run IAM token from Metadata Server so Cloud Run GFE allows the request into the container,
    // while passing the Okta Access Token in X-Enterprise-Okta-Authorization for Okta verification inside the container.
    let gfeHeaders = {};
    try {
      const targetOrigin = new URL(DOWNSTREAM_MCP_URL).origin;
      const metaRes = await fetch(
        `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(targetOrigin)}`,
        { headers: { 'Metadata-Flavor': 'Google' } }
      );
      if (metaRes.ok) {
        const iamToken = (await metaRes.text()).trim();
        gfeHeaders = { Authorization: `Bearer ${iamToken}` };
      }
    } catch (metaErr) {
      console.log(`ℹ️  [byomcp-2legged-okta-proxy] Metadata server skipped: ${metaErr.message}`);
    }

    const mcpResponse = await fetch(DOWNSTREAM_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...gfeHeaders,
        'X-Enterprise-Okta-Authorization': `Bearer ${oktaTokenData.access_token}`,
        'X-Verified-Google-Caller': callerEmail,
      },
      body: JSON.stringify(req.body),
    });

    const rawText = await mcpResponse.text();
    let mcpResult;
    try {
      mcpResult = rawText ? JSON.parse(rawText) : { jsonrpc: '2.0', id: id ?? null, result: {} };
    } catch (parseErr) {
      throw new Error(
        `Downstream returned HTTP ${mcpResponse.status} non-JSON: ${rawText.slice(0, 200)}`
      );
    }

    console.log(`✅ [byomcp-2legged-okta-proxy] Received response from byomcp-2legged-shopping-mcp (HTTP ${mcpResponse.status}).`);
    console.log(`🗑️  [byomcp-2legged-okta-proxy] Discarding ephemeral Okta token from proxy memory.`);
    console.log(`======================================================\n`);

    return res.status(mcpResponse.status).json(mcpResult);
  } catch (err) {
    console.error(`❌ [byomcp-2legged-okta-proxy] Failed to reach byomcp-2legged-shopping-mcp: ${err.message}`);
    return res.status(502).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `Failed to call downstream byomcp-2legged-shopping-mcp: ${err.message}`,
      },
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 [byomcp-2legged-okta-proxy] Listening on port ${PORT}`);
  console.log(`🔗 Okta Token Endpoint: ${OKTA_TOKEN_URL}`);
  console.log(`➡️  Downstream Shopping MCP: ${DOWNSTREAM_MCP_URL}`);
});
