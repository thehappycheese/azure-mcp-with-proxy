# Hello World MCP - Azure

This project contains a bare-bones implementation of an MCP server with
infrastructure as code for the Azure platform, and specialized workarounds for
some annoying Entra limitations. [It is based on this blog post by Matthew Groff.](https://www.groff.dev/blog/azure-entra-id-mcp-server-authentication-incompatibilities).

## Local Setup

1. [install azure cli](https://learn.microsoft.com/en-us/cli/azure/install-azure-cli?view=azure-cli-latest)


## Infrastructure Setup



## App Registrations

## Background

### Why Proxy?

The MCP spec mandates RFC 8707 Resource Indicators, so MCP clients always send a
`resource` parameter in authorize/token requests. Entra's v2.0 endpoints don't
implement RFC 8707 — and rather than ignoring the unrecognized parameter, they
reject the request outright (AADSTS901002 / AADSTS9010010).

Falling back to the v1.0 endpoints doesn't help either. v1.0 does accept a
`resource` parameter, but it must exactly match the registered App ID URI
(`api://[guid]` by default). MCP clients derive `resource` from the MCP server
URL — including the `/mcp` path — so even if you configure the App ID URI to
your base URL, the values can never match, and you don't control what the
client sends.

The proxy therefore sits between the MCP client and Entra: it strips `resource`
before forwarding, mocks dynamic client registration (RFC 7591, unsupported by
Entra), and rewrites Entra's OIDC discovery metadata into the RFC 8414 shape
MCP clients expect. Audience restriction — the security property `resource` was
meant to provide — is enforced server-side by validating the token's `aud`
claim instead.


### Configuring the Redirect URI: Public vs Confidential Clients

Every OAuth client must have its `redirect_uri` pre-registered on the Entra App
Registration that represents it. When registering, each URI goes under exactly
one **Platform Type** (`spa` or `web`), and that choice determines how Entra
expects the token exchange to happen later.

The flow itself is the same for both: the client calls `/oauth/authorize` with
a `redirect_uri`, then listens at that URI for the authorization `code`. The
difference is in how the code is redeemed at `/oauth/token`.

This project can support either platform type with small tweaks to the
`/oauth/token` proxy endpoint. **It is currently configured for the `web`
platform type (confidential clients).**

 - Platform Type: **spa** (public client)
   - enables auth code flow
   - intended for front-end (i.e auth flow happens in users browser)
   - PKCE challenge is required
   - allows token redemption via CORS
     - Must send `Origin` header matching the callback url origin.
   - no `client_secret` is needed anywhere
 - Platform Type: **web** (confidential client)
   - enables auth code flow
   - intended for backends (i.e. auth flow happens server-side)
   - PKCE challenge is optional
   - expects back-channel token redemption (server-to-server / no CORS preflight
     or headers )
     - Must not send the `Origin` header for token redemption
   -  Requires a `client_secret` that must be included with requests to
      `/oauth/token` must provide a  which must be stored securely by the
      client.

In the manifest this looks like

```jsonc
// Entra > App Registration > [app_reg_for_claude_ai] > Manifest
{
    // ...,
    "spa": {
        // redirect can also go here if the /oauth/token endpoint is changed
        // to send the Origin header derived from the redirect_uri:
		// "redirectUris": [ "https://claude.ai/api/mcp/auth_callback" ]
    },
    "web": {
        // ...
        "redirectUris": [
            "http://localhost:8400/callback", // <-- Useful for testing
            "https://claude.ai/api/mcp/auth_callback" 
	    ]
    }
}
```



### requestedAccessTokenVersion v2.0

All entra applications in this solution must be configured to use v2.0 access
tokens. This is achieved by manually editing the manifest in the app
registrations as follows:

```jsonc
// Entra > App Registration > [app_reg] > Manifest
{
    // ...,
    "api": {
        // ...
		"requestedAccessTokenVersion": 2
    }
}
```

This triggers some important differences in the resulting token, and we expect to see the new v2.0 version in this codebase;

1. **Issuer**<br/>
   v2.0 tokens use the new `iss` URL `https://login.microsoftonline.com/${TENANT_ID}/v2.0`
   which must be verified during token validation
1. **Audience:**<br/>
   v2.0 tokens specify `aud` using the GUID of the resource server app registration which must be verified in token validation
1. **name / preferred_username**<br/>
   v2.0 tokens return both. v1.0 tokens only return `name`
1. **appid vs azp**<br/>
   v2.0 tokens use the standardized key `azp` to specify the client app id,
   rather than the old `appid`
   

# Author's Notes

I went on a horrible journey trying to use the **web** platform type described
above. It turned out that I was sending the `Origin` header. This triggered the
error shown below:

> AADSTS9002326: Cross-origin token redemption is permitted only for the
> 'Single-Page Application' client-type. Request origin: `https://claude.ai`.

After switching to SPA, everything worked. Then after updating the
`/oauth/token` endpoint to exclude the `Origin` header I finally got it working
for **web** type requests.