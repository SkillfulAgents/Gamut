/**
 * A `tools/call` for a tool whose scope the credential lacks is refused at
 * the transport, before the SDK runs: HTTP 403 with
 * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`
 * (RFC 6750 §3.1, MCP 2025-11-25 "Scope challenge handling"). That is what
 * MCP clients act on: the TypeScript SDK (Claude Code) answers a 403
 * `insufficient_scope` by re-running authorization for the named scopes once,
 * which sends the person to the consent screen for `gamut:run`; a tool error
 * would only hand the model a message it cannot act on.
 *
 * The registry still checks the scope per call (registry.ts), so a request
 * this pre-check cannot read (an unexpected body shape) is still refused, as
 * a tool error.
 *
 * Only auth mode has partial grants: the installation token grants both
 * scopes, so without auth mode nothing is refused here.
 */
import { isAuthMode } from '@shared/lib/auth/mode'
import type { McpCallContext } from './context'
import { MCP_TOOLS } from './registry'
import { oauthInsufficientScope } from './oauth/challenge'
import { OAUTH_SCOPE_FOR } from './oauth/oauth-config'

const MAX_INSPECTED_BODY_BYTES = 1024 * 1024

const scopeOfTool = new Map(MCP_TOOLS.map((tool) => [tool.name, tool.scope]))

function toolNamesCalled(body: unknown): string[] {
  const messages = Array.isArray(body) ? body : [body]
  const names: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const { method, params } = message as { method?: unknown; params?: { name?: unknown } }
    if (method === 'tools/call' && typeof params?.name === 'string') names.push(params.name)
  }
  return names
}

export async function missingScopeResponse(request: Request, ctx: McpCallContext): Promise<Response | null> {
  if (!isAuthMode() || request.method !== 'POST') return null
  if (!(request.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) return null
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_INSPECTED_BODY_BYTES) return null
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return null
  }
  const missing = new Set<string>()
  for (const name of toolNamesCalled(body)) {
    const scope = scopeOfTool.get(name)
    if (scope && !ctx.scopes.includes(scope)) missing.add(OAUTH_SCOPE_FOR[scope])
  }
  if (missing.size === 0) return null
  const needed = [...missing]
  return oauthInsufficientScope(
    ctx.publicBaseUrl,
    ctx.scopes.map((scope) => OAUTH_SCOPE_FOR[scope]),
    needed,
    `This tool needs the ${needed.join(' and ')} permission, which this connection was not given.`,
  )
}
