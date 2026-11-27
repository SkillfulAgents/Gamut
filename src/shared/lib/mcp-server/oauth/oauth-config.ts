/**
 * The MCP authorization server's fixed policy, in one place: the resource,
 * the scopes, token lifetimes, the consent page, registration limits. Pure
 * (no Better Auth import), so the API, the renderer's types and the tests can
 * all read it.
 *
 * Each auth-mode deployment is its own authorization server (the Platform is
 * not involved). The issuer is the deployment's base URL (Better Auth's
 * `baseURL`, from trusted origins); the one protected resource is
 * `<issuer>/mcp`, the endpoint clients add.
 */
import type { McpToolScope } from '../tool-definition'

export const MCP_RESOURCE_PATH = '/mcp'

/** The OAuth scope for each tool scope (tool-definition.ts). */
export const OAUTH_SCOPE_FOR: Record<McpToolScope, string> = {
  read: 'gamut:read',
  run: 'gamut:run',
}

export const MCP_OAUTH_SCOPES = [OAUTH_SCOPE_FOR.read, OAUTH_SCOPE_FOR.run] as const

/**
 * Not a permission: what makes the provider issue a refresh token. Better
 * Auth's provider issues one only for `offline_access`, which MCP clients do
 * not ask for (they ask for the scopes the server names), so the authorize
 * step adds it (oauth-plugins.ts). The consent screen does not list it.
 */
export const OFFLINE_ACCESS_SCOPE = 'offline_access'

/**
 * Access tokens live 15 minutes. Revocation does not wait for them: every
 * `/mcp` request also checks that the grant still stands (access-token.ts),
 * so the lifetime only bounds a token whose grant check could not run.
 */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 15 * 60

/** Refresh tokens rotate on every use and a family lives at most 30 days without use. */
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * A rotated refresh token presented again inside this window gets the same
 * answer as the first time instead of revoking the family: Claude Code runs
 * several processes sharing one stored token, and two of them refreshing at
 * once must not sign the person out. After it, reuse is replay: the provider
 * revokes every refresh token of that client and person, and answers
 * `invalid_grant`.
 */
export const MCP_REFRESH_REUSE_SECONDS = 30

/** The renderer route the provider sends a person to, signed in or not (consent and login both). */
export const MCP_CONSENT_PAGE_PATH = '/oauth/consent'

/** Headers for the consent page's document: never framed. */
export const CONSENT_PAGE_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
} as const

/** The consent page's paths, as the renderer's case-insensitive router matches them. */
export function isConsentPagePath(path: string): boolean {
  return /^\/oauth(?:\/|$)/i.test(path)
}

/** Better Auth's base path in this app. */
export const AUTH_BASE_PATH = '/api/auth'

/** Dynamic Client Registration (RFC 7591) is open, so it is bounded. */
export const DCR_LIMITS = {
  /** Registrations per client address in an hour. */
  perClientPerHour: 10,
  /** Registrations across the workspace in an hour. */
  globalPerHour: 200,
  /** A registration body larger than this is refused before parsing. */
  maxBodyBytes: 8 * 1024,
  /** Longest accepted `client_name` and any one URI. */
  maxNameChars: 100,
  maxUriChars: 2048,
  maxRedirectUris: 10,
} as const

/** `<base>/mcp`, the resource identifier tokens are bound to. */
export function mcpResourceFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${MCP_RESOURCE_PATH}`
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Whether a deployment at this base URL can be an MCP authorization server:
 * https, or http on a loopback host (development, the e2e suites). A
 * deployment served over plain http on another host gets no OAuth server, and
 * `/mcp` says why, rather than handing out codes over an open network.
 */
export function canServeMcpOAuth(baseUrl: string): boolean {
  const url = URL.parse(baseUrl)
  if (!url || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)
}
