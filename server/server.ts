// server.ts
import express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { fingerprint, logEvent, safeClaimsForLog } from "./server_logging_utils"

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Config (from env) ----
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID!;
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID!;

/// not sure this is needed
//const ALLOWED_CLIENT_IDS = (process.env.ALLOWED_CLIENT_IDS!).split(";");

const APPLICATION_ID_URI = process.env.APPLICATION_ID_URI!;
const REQUIRED_SCOPE = process.env.REQUIRED_SCOPE!;

/// e.g. https://my-app.azurewebsites.net no trailing slash
const BASE_URL = process.env.BASE_URL!;

const AZURE_BASE = `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0`;





// ================================================================
// MCP server definition — a few trivial test tools
// ================================================================
function createMcpServer(claims: JWTPayload) {
    const server = new McpServer({ name: 'azure-mcp-proxy', version: '1.0.0' });

    server.tool(
        'echo',
        'Echo back whatever text you send. Handy connectivity check.',
        { message: z.string().describe('Text to echo back') },
        async ({ message }) => ({
            content: [{ type: 'text', text: `Echo: ${message}` }],
        }),
    );

    server.tool(
        'add',
        'Add two numbers and return the sum.',
        { a: z.number().describe('First number'), b: z.number().describe('Second number') },
        async ({ a, b }) => ({
            content: [{ type: 'text', text: String(a + b) }],
        }),
    );

    // Proves the token actually made it through and was validated
    server.tool(
        'whoami',
        'Return details about the authenticated caller (from the validated JWT).',
        {},
        async () => ({
            content: [{
                type: 'text',
                text: JSON.stringify({
                    // sub: claims.sub,
                    name: (claims as any).name,
                    // preferred_username: (claims as any).preferred_username,
                    roles: (claims as any).roles ?? [],
                }, null, 2),
            }],
        }),
    );

    return server;
}




// ================================================================
// Discovery: tell MCP clients that WE are the auth server
// ================================================================
app.get('/.well-known/oauth-protected-resource', (req, res) => {
    logEvent('discovery.protected-resource', { ua: req.headers['user-agent'] });
    res.json({
        resource: `${BASE_URL}/mcp`,
        authorization_servers: [BASE_URL], // point at ourselves, not Azure
    });
});


app.get('/.well-known/oauth-authorization-server', async (req, res) => {
    logEvent('discovery.auth-server', { ua: req.headers['user-agent'] });
    res.json({
        issuer: `${BASE_URL}`,
        authorization_endpoint: `${BASE_URL}/oauth/authorize`,
        token_endpoint: `${BASE_URL}/oauth/token`,
        code_challenge_methods_supported: ['S256'],
        response_types_supported: ['code'], // REQUIRED by RFC 8414
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
    });
});

// ================================================================
// Authorize: strip `resource`, redirect to Azure
// ================================================================
app.get('/oauth/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    logEvent('oauth.authorize', {
        client_id: q.client_id,
        redirect_uri: q.redirect_uri,
        response_type: q.response_type,
        scope: q.scope,
        resource: q.resource,          // logged, then stripped below
        state: fingerprint(q.state),
        code_challenge_method: q.code_challenge_method,
        has_code_challenge: Boolean(q.code_challenge),
    });
    const params = new URLSearchParams(q);
    params.delete('resource');
    const target = `${AZURE_BASE}/authorize?${params.toString()}`;
    logEvent('oauth.authorize.redirect', { to: `${AZURE_BASE}/authorize`, stripped: ['resource'] });
    res.redirect(target);
});

// ================================================================
// Token: strip `resource`, add Origin for hosted connectors, forward (#3, #10)
// ================================================================
app.post('/oauth/token', async (req, res) => {
    logEvent('oauth.token.request', {
        grant_type: req.body.grant_type,
        client_id: req.body.client_id,
        redirect_uri: req.body.redirect_uri,
        resource: req.body.resource,
        has_code: Boolean(req.body.code),
        has_client_secret: Boolean(req.body.client_secret), // expect true
        has_code_verifier: Boolean(req.body.code_verifier),
        has_refresh_token: Boolean(req.body.refresh_token),
    });

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.body)) {
        if (k !== 'resource') params.append(k, String(v));
    }
    const azureRes = await fetch(`${AZURE_BASE}/token`, {
        method: 'POST',
        headers:{
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
    });

    const bodyText = await azureRes.text();
    let json: any;
    try {
        json = JSON.parse(bodyText);
    } catch {
        json = { raw: bodyText };
    }

    if (azureRes.ok) {
        logEvent('oauth.token.response', {
            status: azureRes.status,
            token_type: json.token_type,
            expires_in: json.expires_in,
            scope: json.scope,
            has_access_token: Boolean(json.access_token),
            has_refresh_token: Boolean(json.refresh_token),
            has_id_token: Boolean(json.id_token),
        });
    } else {
        // Errors are safe to log in full — Azure returns error/description, no secrets.
        logEvent('oauth.token.error', {
            status: azureRes.status,
            error: json.error,
            error_description: json.error_description,
            correlation_id: json.correlation_id,
        });
    }
    res.status(azureRes.status).json(json);
});

// ================================================================
// JWT validation
// ================================================================
const JWKS = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${AZURE_TENANT_ID}/discovery/v2.0/keys`),
);

class InsufficientScopeError extends Error { }
async function validateToken(token: string) {
    const { payload } = await jwtVerify(token, JWKS, {
        issuer: [`https://login.microsoftonline.com/${AZURE_TENANT_ID}/v2.0`],
        audience: [AZURE_CLIENT_ID],
    });
    const scopes = typeof payload.scp === 'string' ? payload.scp.split(' ') : [];
    if (!scopes.includes(REQUIRED_SCOPE)) {
        throw new InsufficientScopeError(
            `token lacks required scope '${REQUIRED_SCOPE}' (scp=${payload.scp ?? '<none>'})`,
        );
    }
    return payload;
}



app.all('/mcp', async (req, res) => {
    const auth = req.headers.authorization;
    const method = req.body?.method;
    logEvent('mcp.request', {
        http_method: req.method,
        rpc_method: method,
        rpc_id: req.body?.id,
        has_auth: Boolean(auth?.startsWith('Bearer ')),
        token_fp: auth?.startsWith('Bearer ') ? fingerprint(auth.slice(7)) : '<none>',
    });

    if (!auth?.startsWith('Bearer ')) {
        logEvent('mcp.unauthorized', { reason: 'missing_bearer' });
        res.set(
            'WWW-Authenticate',
            `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource", scope="${APPLICATION_ID_URI}/${REQUIRED_SCOPE}"`,
        );
        return res.status(401).json({ error: 'unauthorized' });
    }

    let claims: JWTPayload;
    try {
        claims = await validateToken(auth.slice(7));
    } catch (err) {
        if (err instanceof InsufficientScopeError) {
            logEvent('mcp.insufficient_scope', { reason: (err as Error).message });
            res.set(
                'WWW-Authenticate',
                `Bearer error="insufficient_scope", scope="${APPLICATION_ID_URI}/${REQUIRED_SCOPE}"`,
            );
            return res.status(403).json({ error: 'insufficient_scope' });
        }
        logEvent('mcp.invalid_token', { reason: (err as Error).message });
        return res.status(401).json({ error: 'invalid_token' });
    }

    logEvent('mcp.authenticated', { claims: safeClaimsForLog(claims), rpc_method: method });

    // Stateless: a fresh server + transport per request avoids request-ID
    // collisions between concurrent clients and needs no session store.
    const server = createMcpServer(claims);
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
        enableJsonResponse: true,      // plain JSON responses, easier to test
    });

    res.on('close', () => {
        transport.close();
        server.close();
    });

    try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        logEvent('mcp.error', { rpc_method: method, message: (err as Error).message });
        console.error('MCP request error:', err);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
});

app.listen(process.env.PORT || 8080, () => console.log('MCP proxy up'));
