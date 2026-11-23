/**
 * The MCP server: one `createMcpHandler` (the SDK v2 entry) serving both
 * protocol eras statelessly. 2026-07-28 requests carry their version in each
 * request; 2025-era requests (`initialize`, then `tools/list`, …) are each
 * answered by a fresh server instance (`legacy: 'stateless'`), so nothing is
 * kept between requests and any process can answer any request.
 *
 * The handler performs no authentication: the endpoint (src/api/routes/mcp.ts)
 * authenticates first and passes who the call acts for in `authInfo.extra`,
 * and the factory builds the server for that context.
 */
import { createMcpHandler, McpServer, type AuthInfo, type McpHttpHandler, type McpRequestContext, type ProtocolEra } from '@modelcontextprotocol/server'
import { APP_VERSION } from '@shared/lib/config/version'
import type { McpCallContext } from './context'
import { SERVER_INSTRUCTIONS } from './guide'
import { MCP_TOOLS, registerTools } from './registry'

export const MCP_SERVER_NAME = 'gamut'

const CONTEXT_KEY = 'gamutMcpContext'

/** The `authInfo` an authenticated request is served with. */
export function authInfoFor(ctx: McpCallContext): AuthInfo {
  return {
    // Not the credential: the handler never sees it, and nothing here needs it.
    token: ctx.credential.kind,
    clientId: ctx.credential.kind,
    scopes: ctx.scopes.map((scope) => `gamut:${scope}`),
    extra: { [CONTEXT_KEY]: ctx },
  }
}

function contextOf(request: McpRequestContext): McpCallContext {
  const ctx = request.authInfo?.extra?.[CONTEXT_KEY] as McpCallContext | undefined
  // The endpoint always authenticates first; a request without a context is a wiring bug.
  if (!ctx) throw new Error('MCP request reached the server without an authenticated context')
  return ctx
}

export function buildMcpServer(ctx: McpCallContext, era?: ProtocolEra): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: 'Gamut', version: APP_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  )
  registerTools(server, ctx, MCP_TOOLS, { era })
  return server
}

let handler: McpHttpHandler | null = null

/**
 * The process's handler. It holds no per-client state: the modern leg keeps
 * only the exchanges in flight, and the legacy leg builds a server per request.
 */
export function mcpHandler(): McpHttpHandler {
  handler ??= createMcpHandler((request) => buildMcpServer(contextOf(request), request.era), {
    legacy: 'stateless',
    onerror: (error) => console.warn('[mcp-server] request error:', error.message),
  })
  return handler
}
