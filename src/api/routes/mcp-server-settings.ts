/**
 * `/api/mcp-server`: what Settings → MCP Server shows and changes. Behind the
 * app's own auth like every `/api` route; the installation token is never a
 * credential here.
 *
 * - GET: whether this server offers `/mcp`, whether it is on, the endpoint
 *   URL as this request reached the server (the Electron port can move), and
 *   the installation token (non-auth mode).
 * - PUT /enabled: the admin switch.
 * - POST /token/regenerate: replace the token; the old one stops at once.
 */
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { isAuthMode } from '@shared/lib/auth/mode'
import { resolvePublicAppBaseUrl } from '@shared/lib/agent-integrations/app-link'
import { getSettings } from '@shared/lib/config/settings'
import { getOrCreateMcpInstallationToken, regenerateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { isMcpServerEnabledFrom, setMcpServerEnabled } from '@shared/lib/mcp-server/mcp-server-settings'
import { MCP_ROUTE_PATH } from './mcp'
import { Authenticated, IsAdmin } from '../middleware/auth'

export interface McpServerStatusResponse {
  /** False where `/mcp` is not served yet (auth mode, until OAuth lands). */
  available: boolean
  enabled: boolean
  endpointUrl: string
  /** The installation token; null in auth mode, which has none. */
  token: string | null
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
  return {
    available,
    enabled: available && isMcpServerEnabledFrom(settings),
    endpointUrl: await endpointUrlOf(request),
    token: available ? await getOrCreateMcpInstallationToken() : null,
  }
}

routes.get('/', async (c) => c.json(await status(c.req.raw)))

routes.put('/enabled', IsAdmin(), zValidator('json', z.object({ enabled: z.boolean() }).strict()), async (c) => {
  if (isAuthMode()) return c.json({ error: 'The MCP server is not available in this deployment yet' }, 409)
  await setMcpServerEnabled(c.req.valid('json').enabled)
  return c.json(await status(c.req.raw))
})

routes.post('/token/regenerate', IsAdmin(), async (c) => {
  if (isAuthMode()) return c.json({ error: 'This deployment has no installation token' }, 409)
  await regenerateMcpInstallationToken()
  return c.json(await status(c.req.raw))
})

export default routes
