/**
 * `/api/mcp-server`: what Settings → MCP Server shows and changes. Behind the
 * app's own auth like every `/api` route; the installation token is never a
 * credential here.
 *
 * - GET: whether this server offers `/mcp`, whether it is on, the endpoint
 *   URL as this request reached the server (the Electron port can move), and
 *   the installation token (non-auth mode).
 * - PUT /enabled: the admin switch.
 * - PUT /reach: who can reach `/mcp` (this computer, or the network too),
 *   where the server checks request sources (the desktop app).
 * - POST /token/regenerate: replace the token; the old one stops at once.
 */
import * as os from 'node:os'
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { isAuthMode } from '@shared/lib/auth/mode'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
import { getSettings } from '@shared/lib/config/settings'
import { getOrCreateMcpInstallationToken, regenerateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { isMcpServerEnabledFrom, mcpServerReachFrom, setMcpServerEnabled, setMcpServerReach } from '@shared/lib/mcp-server/mcp-server-settings'
import { mcpServerReachSchema, type McpServerStatusResponse } from '@shared/lib/mcp-server/mcp-server-settings-schema'
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

async function status(request: Request): Promise<McpServerStatusResponse> {
  const settings = await getSettings()
  const available = !isAuthMode()
  const reachApplies = checksLoopbackSource()
  return {
    available,
    enabled: available && isMcpServerEnabledFrom(settings),
    endpointUrl: await endpointUrlOf(request),
    token: available ? await getOrCreateMcpInstallationToken() : null,
    reach: {
      applies: reachApplies,
      value: mcpServerReachFrom(settings),
      networkAddresses: reachApplies ? networkAddresses() : [],
    },
  }
}

routes.get('/', async (c) => c.json(await status(c.req.raw)))

routes.put('/enabled', IsAdmin(), zValidator('json', z.object({ enabled: z.boolean() }).strict()), async (c) => {
  if (isAuthMode()) return c.json({ error: 'The MCP server is not available in this deployment yet' }, 409)
  const { enabled, changed } = await setMcpServerEnabled(c.req.valid('json').enabled)
  // Counted only when it changed. No token, address or person in the properties.
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

export default routes
