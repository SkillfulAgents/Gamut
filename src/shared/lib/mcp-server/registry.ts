/**
 * The one list of tools the MCP server offers. The server registers each for
 * the request's context. Adding a tool is adding a definition to a module
 * (tool-definition.ts) and the module to this list.
 *
 * Every call goes through the same steps here: the person's rate limit, the
 * credential's scope, the tool, then one audit row (tool-call-guard.ts).
 */
import { CLIENT_INFO_META_KEY, type McpServer, type ProtocolEra, type ServerContext } from '@modelcontextprotocol/server'
import type { McpCallContext } from './context'
import { MAX_TOOL_NAME_LENGTH, type McpAuditTarget, type McpToolCall, type McpToolDefinition } from './tool-definition'
import { errorResult, jsonResult, runTool } from './tool-result'
import { admitToolCall, auditTargetOf, auditToolCall, rateLimitedMessage } from './tool-call-guard'
import { guideTools } from './tools/guide-tools'
import { driveTools } from './tools/drive-tools'
import { agentTools } from './tools/agent-tools'
import { sessionTools } from './tools/session-tools'
import { runTools } from './tools/run-tools'
import { fileTools } from './tools/file-tools'

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...guideTools,
  ...driveTools,
  ...agentTools,
  ...sessionTools,
  ...runTools,
  ...fileTools,
]

const CLIENT_NAME_MAX_CHARS = 100

/**
 * The client's name, where its protocol era carries it on the request: a
 * 2026-07-28 request has `clientInfo` in its envelope. A 2025-era call is a
 * request of its own on a stateless server, which never saw the `initialize`
 * that named the client, so it is null there.
 */
export function clientNameOf(context: ServerContext | undefined): string | null {
  const envelope = context?.mcpReq?.envelope as Record<string, unknown> | undefined
  const info = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown; title?: unknown } | undefined
  const name = typeof info?.title === 'string' && info.title.trim() ? info.title : info?.name
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, CLIENT_NAME_MAX_CHARS) : null
}

/** Progress notifications for this call, when the client sent a progress token. */
function progressSender(context: ServerContext | undefined): McpToolCall['progress'] {
  const token = context?.mcpReq?._meta?.progressToken
  if (token === undefined || token === null || !context) return async () => {}
  return async (progress, total, message) => {
    try {
      await context.mcpReq.notify({
        method: 'notifications/progress',
        params: { progressToken: token, progress, ...(total !== undefined ? { total } : {}), message },
      })
    } catch {
      // A client that went away, or a transport that cannot stream: progress is best effort.
    }
  }
}

export function registerTools(
  server: McpServer,
  ctx: McpCallContext,
  tools: readonly McpToolDefinition[] = MCP_TOOLS,
  options: { era?: ProtocolEra } = {},
): void {
  const { era } = options
  for (const tool of tools) {
    if (tool.name.length > MAX_TOOL_NAME_LENGTH) throw new Error(`MCP tool name too long: ${tool.name}`)
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: unknown, context?: ServerContext) => {
        const clientName = clientNameOf(context)
        let target: McpAuditTarget = auditTargetOf(args)
        // Counted first: every call that can write an audit row has been
        // admitted, so refusals cannot flood the audit log uncounted.
        const admission = await admitToolCall(ctx.userId)
        if (!admission.admitted) return errorResult(rateLimitedMessage(admission.retryAfterSeconds))
        if (!ctx.scopes.includes(tool.scope)) {
          await auditToolCall({ ctx, tool: tool.name, clientName, era, target, outcome: 'error' })
          return errorResult(`${tool.name} needs the "gamut:${tool.scope}" permission, which this connection was not given. Reconnect and allow it.`)
        }
        const call: McpToolCall = {
          signal: context?.mcpReq?.signal ?? new AbortController().signal,
          progress: progressSender(context),
          clientName,
          setAuditTarget: (more) => { target = { ...target, ...more } },
        }
        const result = await runTool(tool.name, async () => jsonResult(await tool.handler(args as never, ctx, call) as Record<string, unknown>))
        await auditToolCall({ ctx, tool: tool.name, clientName, era, target, outcome: result.isError ? 'error' : 'ok' })
        return result
      },
    )
  }
}
