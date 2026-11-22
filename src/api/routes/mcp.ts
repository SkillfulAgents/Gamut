/**
 * `/mcp`: Gamut's MCP server, for external agents (Claude Code, Codex,
 * Cursor, …). Mounted outside `/api` on purpose: it carries its own
 * credential (the installation token without auth mode), and the local-mode
 * loopback check and the session auth of `/api/*` do not apply to it — just as
 * its token is never accepted on `/api/*`.
 *
 * Order: not served in auth mode (until OAuth lands), 404 while the admin
 * switch is off, then authentication, then the SDK handler inside the user's
 * request scope.
 */
import { Hono } from 'hono'
import { isAuthMode } from '@shared/lib/auth/mode'
import { runWithRequestUser } from '@shared/lib/platform-attribution/request-context'
import { authenticateMcpRequest } from '@shared/lib/mcp-server/authenticate'
import { isMcpServerEnabled } from '@shared/lib/mcp-server/mcp-server-settings'
import { authInfoFor, mcpHandler } from '@shared/lib/mcp-server/server'

export const MCP_ROUTE_PATH = '/mcp'

const mcp = new Hono()

mcp.all('/', async (c) => {
  if (isAuthMode()) return c.json({ error: 'Not found' }, 404)
  if (!(await isMcpServerEnabled())) return c.json({ error: 'Not found' }, 404)
  const auth = await authenticateMcpRequest(c.req.raw)
  if (!auth.ok) return auth.response
  return runWithRequestUser(auth.ctx.userId, () => mcpHandler().fetch(c.req.raw, { authInfo: authInfoFor(auth.ctx) }))
})

export default mcp
