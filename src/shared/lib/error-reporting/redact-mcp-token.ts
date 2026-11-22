/**
 * The MCP installation token (`gamut_mcp_` + base64url) kept out of error
 * reports, server and renderer alike. It can appear in the `Authorization`
 * header the server's HTTP integration attaches to an event raised while
 * handling `/mcp`, and in anything logged or recorded that holds the
 * `GET /api/mcp-server` answer. No SDK import, so the renderer can use it.
 */
const MCP_INSTALLATION_TOKEN = /\bgamut_mcp_[A-Za-z0-9_-]+/g

/** The text with every MCP installation token replaced; the prefix stays, to say what it was. */
export function redactMcpTokens(text: string): string {
  return text.replace(MCP_INSTALLATION_TOKEN, 'gamut_mcp_[redacted]')
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
