/**
 * The endpoint's authentication step: an incoming `/mcp` request becomes the
 * context it acts for, or the response that refuses it. In auth mode the one
 * credential is an OAuth access token this deployment issued
 * (oauth/access-token.ts); without auth mode it is the installation token and
 * the call acts as the local user.
 */
import { isAuthMode } from '@shared/lib/auth/mode'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
import type { McpCallContext } from './context'
import { verifyMcpInstallationToken } from './installation-token'

export type McpAuthentication = { ok: true; ctx: McpCallContext } | { ok: false; response: Response }

/** The user every call acts as without auth mode, as `Authenticated()` sets. */
export const LOCAL_USER_ID = 'local'

/** The presented bearer token, or null without one. */
export function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header)
  return match ? match[1] : null
}

/**
 * A 401 with a plain `WWW-Authenticate: Bearer`: no `resource_metadata`, so a
 * client does not start an OAuth flow this deployment cannot complete.
 */
export function unauthorized(description: string): Response {
  return new Response(JSON.stringify({ error: 'invalid_token', error_description: description }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' },
  })
}

async function publicBaseUrlOf(request: Request): Promise<string> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a served request's URL always parses
  return (await resolvePublicAppBaseUrl(request)) ?? new URL(request.url).origin
}

export async function authenticateMcpRequest(request: Request): Promise<McpAuthentication> {
  if (isAuthMode()) {
    // OAuth access tokens only: the installation token and sessions are refused (oauth/access-token.ts).
    const { authenticateOAuthMcpRequest } = await import('./oauth/access-token')
    return authenticateOAuthMcpRequest(request)
  }
  const token = bearerTokenOf(request)
  if (!token) return { ok: false, response: unauthorized('Send the installation token from Gamut Settings → MCP Server as "Authorization: Bearer <token>".') }
  if (!(await verifyMcpInstallationToken(token))) {
    return { ok: false, response: unauthorized('The token is not this installation\'s current MCP token. Copy it again from Gamut Settings → MCP Server; it changes when someone regenerates it.') }
  }
  return {
    ok: true,
    ctx: {
      userId: LOCAL_USER_ID,
      isAdmin: true,
      publicBaseUrl: await publicBaseUrlOf(request),
      credential: { kind: 'installation-token' },
      // The token stands for the person running Gamut, who may do both.
      scopes: ['read', 'run'],
    },
  }
}
