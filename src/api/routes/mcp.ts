/**
 * `/mcp`: Gamut's MCP server, for external agents (Claude Code, Codex,
 * Cursor, …). Mounted outside `/api` on purpose: it carries its own
 * credential (the installation token without auth mode, an OAuth access token
 * in auth mode), and the local-mode loopback check and the session auth of
 * `/api/*` do not apply to it — just as its credentials are never accepted on
 * `/api/*`.
 *
 * Order: 404 while the admin switch is off, then authentication, then the
 * scope a `tools/call` needs, then the SDK handler inside the user's request
 * scope.
 */
import { Hono } from 'hono'
import { runWithRequestUser } from '@shared/lib/platform-attribution/request-context'
import { authenticateMcpRequest } from '@shared/lib/mcp-server/authenticate'
import { isMcpServerEnabled } from '@shared/lib/mcp-server/mcp-server-settings'
import { authInfoFor, mcpHandler } from '@shared/lib/mcp-server/server'
import { missingScopeResponse } from '@shared/lib/mcp-server/scope-check'

export const MCP_ROUTE_PATH = '/mcp'

const mcp = new Hono()

mcp.all('/', async (c) => {
  if (!(await isMcpServerEnabled())) return c.json({ error: 'Not found' }, 404)
  const auth = await authenticateMcpRequest(c.req.raw)
  if (!auth.ok) return auth.response
  const refused = await missingScopeResponse(c.req.raw, auth.ctx)
  if (refused) return refused
  return runWithRequestUser(auth.ctx.userId, () => mcpHandler().fetch(c.req.raw, { authInfo: authInfoFor(auth.ctx) }))
})

export default mcp
