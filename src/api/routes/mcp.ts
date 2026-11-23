/**
 * `/mcp`: Gamut's MCP server, for external agents (Claude Code, Codex,
 * Cursor, …). Mounted outside `/api` on purpose: it carries its own
 * credential (the installation token without auth mode, an OAuth access token
 * in auth mode), and the local-mode loopback check and the session auth of
 * `/api/*` do not apply to it — just as its credentials are never accepted on
 * `/api/*`.
 *
 * Order: 404 while the admin switch is off, then reach (in the desktop app, a
 * request from another machine is refused unless the admin chose `network`;
 * never in auth mode), then authentication, then the scope a `tools/call`
 * needs, then the SDK handler inside the user's request scope. Reach comes
 * before authentication, so a device that may not reach the server learns
 * nothing about the credential it sent.
 */
import { Hono } from 'hono'
import { runWithRequestUser } from '@shared/lib/platform-attribution/request-context'
import { authenticateMcpRequest } from '@shared/lib/mcp-server/authenticate'
import { getSettings } from '@shared/lib/config/settings'
import { isMcpServerEnabledFrom, mcpServerReachFrom } from '@shared/lib/mcp-server/mcp-server-settings'
import { authInfoFor, mcpHandler } from '@shared/lib/mcp-server/server'
import { missingScopeResponse } from '@shared/lib/mcp-server/scope-check'
import { checksLoopbackSource, isLoopbackSource } from '../middleware/local-mode-auth'

export const MCP_ROUTE_PATH = '/mcp'

const mcp = new Hono()

mcp.all('/', async (c) => {
  const settings = await getSettings()
  if (!isMcpServerEnabledFrom(settings)) return c.json({ error: 'Not found' }, 404)
  if (checksLoopbackSource() && mcpServerReachFrom(settings) === 'this-computer' && !isLoopbackSource(c)) {
    return c.json({ error: 'This MCP server accepts requests from this computer only. Allow other devices in Gamut Settings → MCP Server.' }, 403)
  }
  const auth = await authenticateMcpRequest(c.req.raw)
  if (!auth.ok) return auth.response
  const refused = await missingScopeResponse(c.req.raw, auth.ctx)
  if (refused) return refused
  return runWithRequestUser(auth.ctx.userId, () => mcpHandler().fetch(c.req.raw, { authInfo: authInfoFor(auth.ctx) }))
})

export default mcp
