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
 * What every authorization request is made into before the provider sees it:
 *
 * - `scope`: none means both MCP scopes (what the 401 challenge advertises);
 *   `offline_access` is always added, so a refresh token is issued (MCP
 *   clients never ask for it).
 * - `resource`: none means the one resource this server has (RFC 8707 lets the
 *   server pick a default; without one the provider would issue an opaque
 *   token `/mcp` refuses). Another resource is left for the provider to refuse
 *   with `invalid_target`.
 * - `prompt` always includes `consent`. Every client here is public, and the
 *   native ones (a CIMD `client_id` anyone can name, a loopback redirect on any
 *   port) can be impersonated by any program on the person's machine; without
 *   this, a client approved once would get codes silently forever after
 *   (RFC 8252 §8.6: do not auto-approve native clients). A refresh is not an
 *   authorization request, so staying connected is unaffected.
 */
export function withMcpDefaults(params: Record<string, unknown>, resource: string): Record<string, unknown> {
  const next = { ...params }
  const scopes = typeof params.scope === 'string' ? params.scope.split(' ').filter(Boolean) : []
  const withScopes = scopes.length > 0 ? scopes : [...MCP_OAUTH_SCOPES]
  next.scope = (withScopes.includes(OFFLINE_ACCESS_SCOPE) ? withScopes : [...withScopes, OFFLINE_ACCESS_SCOPE]).join(' ')
  if (next.resource === undefined || next.resource === '') next.resource = resource
  const prompts = typeof params.prompt === 'string' ? params.prompt.split(' ').filter(Boolean) : []
  if (!prompts.includes('none') && !prompts.includes('consent')) next.prompt = [...prompts, 'consent'].join(' ')
  return next
}

/**
 * `prompt=none` asks for a code with no interaction, which forced consent
 * never allows: answer `consent_required` at the client's redirect URI. Only
 * for a client and redirect URI this server already knows to match (the error
 * may go there); anything else is left for the provider, which refuses an
 * unknown redirect without redirecting, and answers `login_required` or
 * `consent_required` itself for a client nobody has approved.
 */
async function promptNoneRefusal(params: Record<string, unknown>, issuer: string): Promise<string | null> {
  const prompts = typeof params.prompt === 'string' ? params.prompt.split(' ') : []
  if (!prompts.includes('none') || typeof params.client_id !== 'string' || typeof params.redirect_uri !== 'string') return null
  const { isRegisteredRedirect } = await import('./connected-clients')
  if (!(await isRegisteredRedirect(params.client_id, params.redirect_uri))) return null
  const url = URL.parse(params.redirect_uri)
  if (!url) return null
  url.searchParams.set('error', 'consent_required')
  url.searchParams.set('error_description', 'This server asks the person to approve every connection')
  if (typeof params.state === 'string') url.searchParams.set('state', params.state)
  url.searchParams.set('iss', issuer)
  return url.href
}

function mcpAuthorizeDefaults(resource: string, issuer: string): BetterAuthPlugin {
  return {
    id: 'gamut-mcp-authorize-defaults',
    hooks: {
      before: [{
        matcher: (ctx) => ctx.path === '/oauth2/authorize',
        handler: createAuthMiddleware(async (ctx) => {
          // The consent endpoint finishes by calling authorize again in
          // process, and this hook runs for that call too. Only a request a
          // client sent to /oauth2/authorize is made to ask for consent; the
          // re-run after the person approved must issue the code.
          const sentByClient = !!ctx.request && (URL.parse(ctx.request.url)?.pathname ?? '').endsWith('/oauth2/authorize')
          if (!sentByClient) return
          const params = (ctx.method === 'POST' ? ctx.body : ctx.query) as Record<string, unknown> | undefined
          const refusal = params && typeof params === 'object' ? await promptNoneRefusal(params, issuer) : null
          if (refusal) throw ctx.redirect(refusal)
          const query = ctx.query && typeof ctx.query === 'object' ? withMcpDefaults(ctx.query as Record<string, unknown>, resource) : ctx.query
          const body = ctx.method === 'POST' && ctx.body && typeof ctx.body === 'object' ? withMcpDefaults(ctx.body as Record<string, unknown>, resource) : ctx.body
          return { context: { query, body } }
        }),
      }],
      // RFC 6749 §5.2: a refresh token the server cannot use is `invalid_grant`.
      // The provider says `invalid_token` for one it cannot even decode (no
      // prefix, garbage); clients key re-authorization on `invalid_grant`.
      after: [{
        // Analytics of the person's answer: once per accepted consent the
        // provider recorded (its answer sends the browser on with a code), and
        // once per decline. Fire-and-forget; see oauth-analytics.ts.
        matcher: (ctx) => ctx.path === '/oauth2/consent',
        handler: createAuthMiddleware(async (ctx) => {
          try {
            const returned = ctx.context.returned as { url?: unknown } | undefined
            if (!returned || isAPIError(returned) || typeof returned.url !== 'string') return
            const body = ctx.body as { accept?: unknown; oauth_query?: unknown } | undefined
            const clientId = typeof body?.oauth_query === 'string' ? new URLSearchParams(body.oauth_query).get('client_id') : null
            if (!clientId) return
            const answer = URL.parse(returned.url)?.searchParams
            const { trackClientConnected, trackConsentDenied } = await import('./oauth-analytics')
            if (body?.accept === true && answer?.get('code')) trackClientConnected(clientId, ctx.context.session?.user.id)
            else if (body?.accept !== true && answer?.get('error') === 'access_denied') trackConsentDenied(clientId)
          } catch {
            // Analytics never breaks the answer.
          }
        }),
      }, {
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
    mcpAuthorizeDefaults(resource, baseUrl.replace(/\/+$/, '')),
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
