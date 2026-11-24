/**
 * MCP credentials kept out of error reports, server and renderer alike:
 *
 * - the installation token (`gamut_mcp_` + base64url), in the `Authorization`
 *   header the server's HTTP integration attaches to an event raised while
 *   handling `/mcp`, and in anything holding the `GET /api/mcp-server` answer;
 * - OAuth access tokens (JWTs, in the same header);
 * - OAuth refresh tokens (`gamut_rt_` + random, in token requests);
 * - authorization codes and refresh tokens in a URL or form body
 *   (`code=…`, `refresh_token=…`, `code_verifier=…`), as the token request
 *   and the redirect back to a client carry them.
 *
 * No SDK import, so the renderer can use it.
 */
const MCP_INSTALLATION_TOKEN = /\bgamut_mcp_[A-Za-z0-9_-]+/g
/** Refresh tokens carry this prefix (oauth-plugins.ts); it is not stored. */
export const MCP_REFRESH_TOKEN_PREFIX = 'gamut_rt_'
const MCP_REFRESH_TOKEN = /\bgamut_rt_[A-Za-z0-9_-]+/g
/** A compact JWS: any JWT, of which access tokens are one kind. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g
/** Token-shaped parameters are redacted wherever they appear. */
const OAUTH_TOKEN_PARAMETER = /\b(refresh_token|access_token|code_verifier)=[^&\s"']+/g
/**
 * `code=` only where an authorization code can be: in a query string (after
 * `?` or `&`) or at the start of a form body. "exit code=1" and
 * "code=ENOENT" in prose stay readable.
 */
const AUTHORIZATION_CODE_PARAMETER = /(^|[?&])code=[^&\s"']+/g

/** The text with every MCP credential replaced; a prefix or parameter name stays, to say what it was. */
export function redactMcpTokens(text: string): string {
  return text
    .replace(MCP_INSTALLATION_TOKEN, 'gamut_mcp_[redacted]')
    .replace(MCP_REFRESH_TOKEN, `${MCP_REFRESH_TOKEN_PREFIX}[redacted]`)
    .replace(JWT, '[redacted-jwt]')
    .replace(OAUTH_TOKEN_PARAMETER, '$1=[redacted]')
    .replace(AUTHORIZATION_CODE_PARAMETER, '$1code=[redacted]')
}

/** Redact the token in every string of an object, in place. */
export function redactMcpTokensDeep<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === 'string') Reflect.set(value, key, redactMcpTokens(inner))
    else if (inner && typeof inner === 'object') redactMcpTokensDeep(inner)
  }
  return value
}
