/**
 * `/api/mcp-server`: what Settings → MCP Server shows and changes. Behind the
 * app's own auth like every `/api` route; neither the installation token nor
 * an MCP access token is ever a credential here.
 *
 * - GET: whether this server offers `/mcp`, whether it is on, the endpoint
 *   URL, how clients connect, the installation token (non-auth mode), and
 *   who can reach `/mcp`.
 * - PUT /enabled: the admin switch (workspace-wide in auth mode).
 * - PUT /reach: who can reach `/mcp` (this computer, or the network too),
 *   where the server checks request sources (the desktop app).
 * - POST /token/regenerate: replace the token; the old one stops at once.
 * - Auth mode only, for the person asking and nobody else:
 *   GET /oauth/clients lists their connected clients,
 *   POST /oauth/clients/revoke disconnects one,
 *   GET /oauth/consent-client describes the client a consent screen is for.
 */
import * as os from 'node:os'
import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { isAuthMode } from '@shared/lib/auth/mode'
import { getCurrentUserId } from '@shared/lib/auth/config'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
import { getSettings } from '@shared/lib/config/settings'
import { getOrCreateMcpInstallationToken, regenerateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { isMcpServerEnabledFrom, mcpServerReachFrom, setMcpServerEnabled, setMcpServerReach } from '@shared/lib/mcp-server/mcp-server-settings'
import { mcpServerReachSchema, revokeMcpClientRequestSchema, type McpServerStatusResponse } from '@shared/lib/mcp-server/mcp-server-settings-schema'
import { canServeMcpOAuth, mcpResourceFor } from '@shared/lib/mcp-server/oauth/oauth-config'
import { checksLoopbackSource } from '../middleware/local-mode-auth'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { MCP_ROUTE_PATH } from './mcp'
import { Authenticated, IsAdmin } from '../middleware/auth'

/** This machine's non-internal IPv4 addresses: where other devices on the network reach it. */
function networkAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal)
    .map((address) => address.address)
}

const routes = new Hono()
routes.use('*', Authenticated())

async function endpointUrlOf(request: Request): Promise<string> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a served request's URL always parses
  const base = (await resolvePublicAppBaseUrl(request)) ?? new URL(request.url).origin
  return `${base}${MCP_ROUTE_PATH}`
}

const NOT_HTTPS = 'This workspace is not served over https, so MCP clients cannot sign in to it. An administrator can set its public https address (TRUSTED_ORIGINS).'

async function status(request: Request): Promise<McpServerStatusResponse> {
  const settings = await getSettings()
  if (isAuthMode()) {
    const { mcpAuthorizationBaseUrl } = await import('@shared/lib/mcp-server/oauth/access-token')
    const baseUrl = await mcpAuthorizationBaseUrl()
    const available = canServeMcpOAuth(baseUrl)
    return {
      available,
      unavailableReason: available ? null : NOT_HTTPS,
      auth: 'oauth',
      enabled: available && isMcpServerEnabledFrom(settings),
      // The resource tokens are bound to: exactly what clients must add.
      endpointUrl: mcpResourceFor(baseUrl),
      token: null,
      // Reach is the deployment's infrastructure here, never this server's check.
      reach: { applies: false, value: mcpServerReachFrom(settings), networkAddresses: [] },
    }
  }
  const reachApplies = checksLoopbackSource()
  return {
    available: true,
    unavailableReason: null,
    auth: 'installation-token',
    enabled: isMcpServerEnabledFrom(settings),
    endpointUrl: await endpointUrlOf(request),
    token: await getOrCreateMcpInstallationToken(),
    reach: {
      applies: reachApplies,
      value: mcpServerReachFrom(settings),
      networkAddresses: reachApplies ? networkAddresses() : [],
    },
  }
}

routes.get('/', async (c) => c.json(await status(c.req.raw)))

routes.put('/enabled', IsAdmin(), zValidator('json', z.object({ enabled: z.boolean() }).strict()), async (c) => {
  const current = await status(c.req.raw)
  if (!current.available) return c.json({ error: current.unavailableReason ?? 'The MCP server is not available here' }, 409)
  const { enabled, changed } = await setMcpServerEnabled(c.req.valid('json').enabled)
  // Counted only when it changed, in either mode. No token, address or person in the properties.
  if (changed) trackServerEvent('mcp_server_toggled', { enabled, auth_mode: isAuthMode() })
  return c.json(await status(c.req.raw))
})

routes.put('/reach', IsAdmin(), zValidator('json', z.object({ reach: mcpServerReachSchema }).strict()), async (c) => {
  if (!checksLoopbackSource()) return c.json({ error: 'This server does not check where requests come from; its network setup decides who reaches it' }, 409)
  const { reach, changed } = await setMcpServerReach(c.req.valid('json').reach)
  if (changed) trackServerEvent('mcp_reach_changed', { reach })
  return c.json(await status(c.req.raw))
})

routes.post('/token/regenerate', IsAdmin(), async (c) => {
  if (isAuthMode()) return c.json({ error: 'This deployment has no installation token' }, 409)
  await regenerateMcpInstallationToken()
  trackServerEvent('mcp_token_regenerated')
  return c.json(await status(c.req.raw))
})

function oauthOnly(c: Context): Response | null {
  return isAuthMode() ? null : c.json({ error: 'Not found' }, 404)
}

routes.get('/oauth/clients', async (c) => {
  const refused = oauthOnly(c)
  if (refused) return refused
  const { listConnectedClients } = await import('@shared/lib/mcp-server/oauth/connected-clients')
  return c.json({ clients: await listConnectedClients(getCurrentUserId(c)) })
})

routes.post('/oauth/clients/revoke', zValidator('json', revokeMcpClientRequestSchema), async (c) => {
  const refused = oauthOnly(c)
  if (refused) return refused
  const { revokeConnectedClient } = await import('@shared/lib/mcp-server/oauth/connected-clients')
  const revoked = await revokeConnectedClient(getCurrentUserId(c), c.req.valid('json').clientId)
  return revoked ? c.json({ revoked: true }) : c.json({ error: 'No such connected client' }, 404)
})

routes.get('/oauth/consent-client', zValidator('query', z.object({
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().max(4096).optional(),
})), async (c) => {
  const refused = oauthOnly(c)
  if (refused) return refused
  const { client_id: clientId, redirect_uri: redirectUri } = c.req.valid('query')
  const { consentClientInfo } = await import('@shared/lib/mcp-server/oauth/connected-clients')
  const info = await consentClientInfo(clientId, redirectUri ?? null)
  return info ? c.json(info) : c.json({ error: 'Unknown client' }, 404)
})

export default routes
