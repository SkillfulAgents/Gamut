/**
 * The `WWW-Authenticate` answers `/mcp` gives in auth mode (RFC 6750 §3,
 * RFC 9728 §5.1):
 *
 * - 401, no or a bad token: `Bearer resource_metadata="…", scope="…"`, plus
 *   `error="invalid_token"` and a description when a token was sent. MCP
 *   clients start (or restart) authorization from `resource_metadata`.
 * - 403, a valid token without a scope the call needs:
 *   `Bearer error="insufficient_scope", scope="…", resource_metadata="…"`.
 *   `scope` names every scope the call needs together with what the token
 *   already has, so a client stepping up keeps what it had (MCP 2025-11-25
 *   "Scope challenge handling").
 */
import { MCP_OAUTH_SCOPES, MCP_RESOURCE_PATH } from './oauth-config'

/** RFC 9728 §3.1: the metadata of `<origin>/mcp` is at `<origin>/.well-known/oauth-protected-resource/mcp`. */
export function protectedResourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`
}

/** An auth-param value: a quoted-string with `\` and `"` escaped, and nothing a header cannot carry. */
function quoted(value: string): string {
  return `"${value.replace(/[^\x20-\x7e]/g, '').replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

function jsonRpcError(status: 401 | 403, message: string, challenge: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'WWW-Authenticate': challenge,
      // Browser-based MCP clients read the challenge cross-origin.
      'Access-Control-Expose-Headers': 'WWW-Authenticate',
      'Cache-Control': 'no-store',
    },
  })
}

/** No token, or one `/mcp` does not accept. `description` is shown to the person by some clients. */
export function oauthUnauthorized(baseUrl: string, tokenPresented: boolean, description: string): Response {
  const params = [
    ...(tokenPresented ? [`error="invalid_token"`, `error_description=${quoted(description)}`] : []),
    `resource_metadata=${quoted(protectedResourceMetadataUrl(baseUrl))}`,
    `scope=${quoted(MCP_OAUTH_SCOPES.join(' '))}`,
  ]
  return jsonRpcError(401, description, `Bearer ${params.join(', ')}`)
}

/** A valid token without `needed`; the challenge asks for `needed` plus what was granted. */
export function oauthInsufficientScope(baseUrl: string, granted: readonly string[], needed: readonly string[], description: string): Response {
  const scope = [...new Set([...granted.filter((s) => (MCP_OAUTH_SCOPES as readonly string[]).includes(s)), ...needed])].join(' ')
  const params = [
    `error="insufficient_scope"`,
    `scope=${quoted(scope)}`,
    `resource_metadata=${quoted(protectedResourceMetadataUrl(baseUrl))}`,
    `error_description=${quoted(description)}`,
  ]
  return jsonRpcError(403, description, `Bearer ${params.join(', ')}`)
}
