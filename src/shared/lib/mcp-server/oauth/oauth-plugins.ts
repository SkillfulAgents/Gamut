/**
 * The Better Auth plugins that make an auth-mode deployment the MCP
 * authorization server: `jwt` (signing keys and the JWKS), `@better-auth/mcp`
 * (the OAuth 2.1 provider bound to the `/mcp` resource, plus RFC 9728
 * metadata) and `@better-auth/cimd` (Client ID Metadata Documents), with
 * open Dynamic Client Registration for clients that have no CIMD (Cursor).
 *
 * Added to the one Better Auth instance (auth/index.ts), so the consent page
 * uses the person's ordinary session and sign-in (password or SSO). The
 * provider's tokens are not sessions: the `bearer` plugin never accepts them
 * on `/api/*`, and `/mcp` accepts nothing else (access-token.ts).
 */
import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api'
import { jwt } from 'better-auth/plugins'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import { MCP_REFRESH_TOKEN_PREFIX } from '@shared/lib/error-reporting/redact-mcp-token'
import { cimdTransport } from './cimd-transport'
import {
  AUTH_BASE_PATH,
  canServeMcpOAuth,
  DCR_LIMITS,
  MCP_ACCESS_TOKEN_TTL_SECONDS,
  MCP_CONSENT_PAGE_PATH,
  MCP_OAUTH_SCOPES,
  MCP_REFRESH_REUSE_SECONDS,
  MCP_REFRESH_TOKEN_TTL_SECONDS,
  mcpResourceFor,
  OFFLINE_ACCESS_SCOPE,
} from './oauth-config'

/** The signing algorithm of access tokens. Verification accepts this one only (no `none`, no HMAC). */
export const MCP_ACCESS_TOKEN_ALG = 'EdDSA'

/** Keys rotate every 90 days; a retired key still verifies for 30 more, past any token it signed. */
const KEY_ROTATION_SECONDS = 90 * 24 * 60 * 60
const KEY_GRACE_SECONDS = 30 * 24 * 60 * 60

const SCOPES = [...MCP_OAUTH_SCOPES, OFFLINE_ACCESS_SCOPE]

/**
 * Every authorization request gets `offline_access` (so a refresh token is
 * issued: MCP clients never ask for it) and, when it names none, the one
 * resource this server has (RFC 8707 lets the server pick a default; without
 * a resource the provider would issue an opaque token `/mcp` refuses). A
 * request naming another resource is left alone, and the provider refuses it
 * with `invalid_target`.
 */
function withMcpDefaults(params: Record<string, unknown>, resource: string): Record<string, unknown> {
  const scopes = typeof params.scope === 'string' ? params.scope.split(' ').filter(Boolean) : []
  const next = { ...params }
  if (scopes.length > 0 && !scopes.includes(OFFLINE_ACCESS_SCOPE)) next.scope = [...scopes, OFFLINE_ACCESS_SCOPE].join(' ')
  if (next.resource === undefined || next.resource === '') next.resource = resource
  return next
}

function mcpAuthorizeDefaults(resource: string): BetterAuthPlugin {
  return {
    id: 'gamut-mcp-authorize-defaults',
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === '/oauth2/authorize',
        handler: createAuthMiddleware(async (ctx) => {
          const query = ctx.query && typeof ctx.query === 'object' ? withMcpDefaults(ctx.query as Record<string, unknown>, resource) : ctx.query
          const body = ctx.method === 'POST' && ctx.body && typeof ctx.body === 'object' ? withMcpDefaults(ctx.body as Record<string, unknown>, resource) : ctx.body
          return { context: { query, body } }
        }),
      }],
      // RFC 6749 §5.2: a refresh token the server cannot use is `invalid_grant`.
      // The provider says `invalid_token` for one it cannot even decode (no
      // prefix, garbage); clients key re-authorization on `invalid_grant`.
      after: [{
        matcher: (ctx) => ctx.path === '/oauth2/token',
        handler: createAuthMiddleware(async (ctx) => {
          const returned = ctx.context.returned
          if (!isAPIError(returned) || (returned.body as { error?: unknown } | undefined)?.error !== 'invalid_token') return
          throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'invalid refresh token' })
        }),
      }],
    },
  }
}

/**
 * The plugins, or none when this base URL cannot be an authorization server
 * (plain http off loopback): building them would throw, and sign-in must keep
 * working when it does.
 */
export function mcpOAuthPlugins(baseUrl: string) {
  if (!canServeMcpOAuth(baseUrl)) return []
  const resource = mcpResourceFor(baseUrl)
  return [
    jwt({
      // The issuer is the deployment, so clients find the server metadata at
      // the root (`/.well-known/oauth-authorization-server`), RFC 8414's
      // simplest form.
      jwt: { issuer: baseUrl },
      // No JWT in a `set-auth-jwt` header on session reads: nothing here uses it.
      disableSettingJwtHeader: true,
      jwks: {
        keyPairConfig: { alg: MCP_ACCESS_TOKEN_ALG },
        rotationInterval: KEY_ROTATION_SECONDS,
        gracePeriod: KEY_GRACE_SECONDS,
      },
    }),
    mcpAuthorizeDefaults(resource),
    mcp({
      resource,
      scopes: SCOPES,
      advertisedMetadata: { scopes_supported: SCOPES },
      // Code and refresh only: no client_credentials, a token always acts for a person.
      grantTypes: ['authorization_code', 'refresh_token'],
      loginPage: MCP_CONSENT_PAGE_PATH,
      consentPage: MCP_CONSENT_PAGE_PATH,
      accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenExpiresIn: MCP_REFRESH_TOKEN_TTL_SECONDS,
      refreshTokenReuseInterval: MCP_REFRESH_REUSE_SECONDS,
      codeExpiresIn: 600,
      // Recognizable, so error reports and secret scanners can find it.
      prefix: { refreshToken: MCP_REFRESH_TOKEN_PREFIX },
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Native clients (Claude Code, Codex, Cursor) register loopback
      // redirects without saying `application_type: native`.
      clientRegistrationDefaultApplicationType: 'infer',
      // Counted in AppState in front of the provider (dcr-limits.ts); the
      // provider's own limiter is per process and only on in production.
      rateLimit: { register: { window: 3600, max: DCR_LIMITS.perClientPerHour } },
      // No client or resource is managed through a person's session (see MCP_OAUTH_DISABLED_PATHS).
      clientPrivileges: () => false,
      resourcePrivileges: () => false,
    }),
    cimd({
      fetchClientMetadataResource: cimdTransport(),
      // The MCP 2026-07-28 profile: a document must name the client and its redirect URIs.
      metadataProfile: 'mcp-2026-07-28',
    }),
  ]
}

/**
 * Provider endpoints this deployment does not offer over HTTP. Clients are
 * only registered (DCR or CIMD), never managed through a person's session,
 * so the session CRUD for clients is off; consents are listed and revoked by
 * Settings → MCP Server (`/api/mcp-server/oauth/clients`), which also revokes
 * the client's tokens, so the provider's own consent edits are off; there is
 * no OpenID Connect (no `openid` scope), so `userinfo` and end-session are
 * off. The `jwt` plugin's `GET /token` would turn a browser session into a
 * JWT, which nothing uses.
 */
export const MCP_OAUTH_DISABLED_PATHS = [
  '/token',
  '/oauth2/create-client',
  '/oauth2/get-client',
  '/oauth2/get-clients',
  '/oauth2/update-client',
  '/oauth2/delete-client',
  '/oauth2/client/rotate-secret',
  '/oauth2/client/rotate-keys',
  '/oauth2/get-consent',
  '/oauth2/get-consents',
  '/oauth2/update-consent',
  '/oauth2/delete-consent',
  '/oauth2/public-client',
  '/oauth2/public-client-prelogin',
  '/oauth2/continue',
  '/oauth2/userinfo',
  '/oauth2/end-session',
]

/** The issuer every token carries, and the base of the endpoints the metadata lists. */
export function mcpIssuerFor(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** The JWKS the `jwt` plugin serves (public keys only). */
export function mcpJwksUrlFor(baseUrl: string): string {
  return `${mcpIssuerFor(baseUrl)}${AUTH_BASE_PATH}/jwks`
}
