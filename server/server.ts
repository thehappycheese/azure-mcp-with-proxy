// server.ts
import {
    registerAppResource,
    registerAppTool,
    RESOURCE_MIME_TYPE, // 'text/html;profile=mcp-app'
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { fingerprint, logEvent, safeClaimsForLog } from "./server_logging_utils.js";



const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(cors({
    origin: true, // or an allowlist
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'], // needed so browser clients can read your 401 challenge
}));

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




// MARK: MCP SERVER
function createMcpServer(claims: JWTPayload) {
    const server = new McpServer({ name: 'azure-mcp-proxy', version: '1.0.0' });

    // ------------------------------------------------------------
    // TOOLS
    // ------------------------------------------------------------
    server.registerTool(
        'echo',
        {
            title: 'Echo',
            description: 'Echo back whatever text you send. Handy connectivity check.',
            inputSchema: z.object({
                message: z.string().describe('Text to echo back'),
            }),
            annotations: { readOnlyHint: true },
        },
        async ({ message }) => ({
            content: [{ type: 'text', text: `Echo: ${message}` }],
        }),
    );

    server.registerTool(
        'whoami',
        {
            title: 'Who am I',
            description: 'Return details about the authenticated caller (from the validated JWT).',
            inputSchema: z.object({}),
            outputSchema: z.object({
                name: z.string().optional(),
                roles: z.array(z.string()),
            }),
            annotations: { readOnlyHint: true },
        },
        async () => {
            const output = {
                name: (claims as any).name as string | undefined,
                roles: ((claims as any).roles ?? []) as string[],
            };
            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
                structuredContent: output,
            };
        },
    );

    // ------------------------------------------------------------
    // MCP APP (widget) — button that shows the current server time.
    // The tool both seeds the widget on first render (ontoolresult)
    // and serves the widget's callServerTool('get-time') on click.
    // ------------------------------------------------------------
    const timeUiUri = 'ui://azure-mcp-proxy/time.html';

    registerAppResource(
        server as any,
        'time-card',
        timeUiUri,
        {
            _meta: {
                ui: {
                    csp: {
                        // everything is inlined by the bundler, so no external origins
                        resourceDomains: [],
                        connectDomains: [],
                    },
                },
            },
        },
        async () => ({
            contents: [{
                uri: timeUiUri,
                mimeType: RESOURCE_MIME_TYPE,
                text: await TIME_CARD_HTML,
            }],
        }),
    );

    registerAppTool(
        server,
        'get-time',
        {
            title: 'Get time',
            description: 'Return the current server time, shown as a card with a button to refresh it.',
            inputSchema: z.object({}),
            outputSchema: z.object({ time: z.string() }),
            annotations: { readOnlyHint: true },
            _meta: { ui: { resourceUri: timeUiUri } },
        },
        async () => {
            const output = { time: new Date().toISOString() };
            return {
                // the widget reads this text content
                content: [{ type: 'text', text: output.time }],
                structuredContent: output,
            };
        },
    );

    return server;
}

// The widget itself: plain HTML + the ext-apps `App` client, which bridges
// iframe <-> host. Everything is inlined so no CSP config is needed.
// (For real apps, bundle with vite-plugin-singlefile instead of a CDN import.)
const WHOAMI_CARD_HTML = fs.readFile('whoami.html', 'utf-8');



// MARK: .well-known/
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

// MARK: OAuth 

// ================================================================
// Authorize: strip `resource`, redirect to Azure
// ================================================================
const FORWARDED = [
    'client_id', 'response_type', 'scope', 'state',
    'code_challenge', 'code_challenge_method', 'redirect_uri',
    'prompt', 'login_hint',
    // 'resource' // <-- do not forward. Entra will not tolerate the presence of this parameter.
] as const;
app.get('/oauth/authorize', (req, res) => {
    // logEvent('oauth.authorize.raw', { url: req.originalUrl });
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
    logEvent('oauth.authorize.redirect', { to: `${AZURE_BASE}/authorize`, stripped: ['resource'] });
    const params = new URLSearchParams();
    for (const key of FORWARDED) {
        const raw = req.query[key];
        if (raw === undefined) continue;
        const values = Array.isArray(raw) ? raw : [raw];
        const unique = [...new Set(values.map(String))];
        if (unique.length > 1) {
            // conflicting duplicates — reject per OAuth 2.0 (params MUST NOT repeat)
            return res.status(400).json({ error: 'invalid_request', error_description: `duplicate parameter: ${key}` });
        }
        params.set(key, unique[0]);
    }
    res.redirect(`${AZURE_BASE}/authorize?${params.toString()}`);
});

// ================================================================
// Token
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

    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }

    if (!req.body.client_secret) {
        // try to also support public client flow. possibly problematic.
        if (req.headers.origin) {
            headers["Origin"] = req.headers.origin
        } else {
            headers["Origin"] = new URL(req.body.redirect_uri).origin
        }
    }

    const azureRes = await fetch(`${AZURE_BASE}/token`, {
        method: 'POST',
        headers,
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

// MARK: MCP

app.all('/mcp', async (req, res) => {
    const auth = req.headers.authorization;
    const method = req.body?.method;
    logEvent('mcp.request', {
        http_method: req.method,
        rpc_method: method,
        rpc_id: req.body?.id,
        has_auth: Boolean(auth?.startsWith('Bearer ')),
        token_fp: auth?.startsWith('Bearer ') ? fingerprint(auth.slice(7)) : '<none>',
        body_keys: Object.keys(req.body).join("; "),
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

// MARK: app.listen
app.listen(process.env.PORT || 8080, () => console.log('MCP proxy up'));
