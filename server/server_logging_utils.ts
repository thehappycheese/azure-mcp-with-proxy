import type { JWTPayload } from 'jose';

// ================================================================
// Logging helpers — informative, but never leak secrets
// ================================================================

// Keys whose values must never hit the logs, even partially.
const SENSITIVE_KEYS = new Set([
    'authorization',
    'access_token',
    'refresh_token',
    'id_token',
    'code',
    'code_verifier',
    'client_secret',
    'assertion',
    'client_assertion',
    'password',
]);

// Show enough of an opaque value to correlate logs without revealing it.
export function fingerprint(value?: string): string {
    if (!value) return '<none>';
    if (value.length <= 8) return `<redacted:${value.length}b>`;
    return `${value.slice(0, 4)}…${value.slice(-2)} (len=${value.length})`;
}

// Recursively redact a params/body object for safe logging.
function redact(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
        if (SENSITIVE_KEYS.has(k.toLowerCase())) {
            out[k] = fingerprint(typeof v === 'string' ? v : undefined);
        } else {
            out[k] = v;
        }
    }
    return out;
}

let seq = 0;
export function logEvent(log_type: string, data: Record<string, unknown> = {}) {
    const line = {
        seq: ++seq,
        log_type,
        ...redact(data),
    };
    console.log(JSON.stringify(line));
}

// Decode (WITHOUT verifying) just to log claims. Never trust these —
// validateToken() is the real gate. This is purely for observability.
export function safeClaimsForLog(claims: JWTPayload) {
    return {
        sub: claims.sub,
        aud: claims.aud,
        iss: claims.iss,
        name: (claims as any).name,
        preferred_username: (claims as any).preferred_username,
        roles: (claims as any).roles ?? [],
        scp: (claims as any).scp,
        appid: (claims as any).appid,
        azp: (claims as any).azp,
        exp: claims.exp,
        iat: claims.iat,
        // How long until this token expires, if present.
        expires_in_s: claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : undefined,
    };
}