/**
 * The discovery documents an MCP client reads before it signs in, at the
 * root of the deployment (auth mode only):
 *
 * - RFC 9728 protected-resource metadata for `/mcp`, at the path-suffixed form
 *   `/.well-known/oauth-protected-resource/mcp` (what the 401 points at) and at
 *   the root form `/.well-known/oauth-protected-resource` (what older clients
 *   probe). `resource` is exactly the `/mcp` URL tokens are bound to.
 * - RFC 8414 authorization-server metadata at
 *   `/.well-known/oauth-authorization-server` (the issuer is the deployment's
 *   base URL, with no path), built by the provider so it lists exactly what
 *   it serves: endpoints, `S256` only, `client_id_metadata_document_supported`,
 *   the registration endpoint, the scopes.
 * - `/.well-known/openid-configuration`: this server is not an OpenID
 *   provider (no `openid` scope), so it answers 404, in JSON. Clients that
 *   probe it fall back to the RFC 8414 document; a plain 404 keeps the web
 *   build's SPA fallback from answering it with the app's HTML.
 *
 * While the admin switch is off, or when this deployment cannot be an
 * authorization server (plain http off loopback), every one of them answers
 * 404: there is nothing to sign in to, and `/mcp` answers 404 too.
 */
import { Hono } from 'hono'
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { isMcpServerEnabled } from '@shared/lib/mcp-server/mcp-server-settings'
import { mcpAuthorizationBaseUrl } from '@shared/lib/mcp-server/oauth/access-token'
import { canServeMcpOAuth, MCP_OAUTH_SCOPES, mcpResourceFor } from '@shared/lib/mcp-server/oauth/oauth-config'
import { mcpIssuerFor } from '@shared/lib/mcp-server/oauth/oauth-plugins'

const discovery = new Hono()

const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

function metadataJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Clients fetch these cross-origin from browsers (claude.ai's connector UI).
      'Access-Control-Allow-Origin': '*',
      // Short: the switch and the base URL can change.
      'Cache-Control': 'public, max-age=300',
    },
  })
}

/** The base URL when discovery is served, else null. */
async function servedBaseUrl(): Promise<string | null> {
  if (!(await isMcpServerEnabled())) return null
  const baseUrl = await mcpAuthorizationBaseUrl()
  return canServeMcpOAuth(baseUrl) ? baseUrl : null
}

/** RFC 9728 §2 metadata for the `/mcp` resource. */
export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: mcpResourceFor(baseUrl),
    authorization_servers: [mcpIssuerFor(baseUrl)],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Gamut',
    resource_documentation: `${baseUrl}/settings/mcp-server`,
  }
}

const servePrm = async () => {
  const baseUrl = await servedBaseUrl()
  return baseUrl ? metadataJson(protectedResourceMetadata(baseUrl)) : notFound()
}
discovery.get('/oauth-protected-resource', servePrm)
discovery.get('/oauth-protected-resource/mcp', servePrm)

discovery.get('/oauth-authorization-server', async (c) => {
  if (!(await servedBaseUrl())) return notFound()
  const { getAuth } = await import('@shared/lib/auth')
  const response = await oauthProviderAuthServerMetadata(await getAuth())(c.req.raw)
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(response.body, { status: response.status, headers })
})

discovery.get('/openid-configuration', () => notFound())

export default discovery
