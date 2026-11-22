/**
 * What every MCP tool call passes through besides the tool: a per-person rate
 * limit, and one audit row.
 *
 * Rate limit: `MCP_TOOL_CALLS_PER_MINUTE` calls per person in a fixed window
 * (AppState, so every process serving the tenant counts together). An agent
 * working through a task calls a few tools a minute and bursts to perhaps
 * twenty or thirty; 120 leaves that untouched and stops a runaway loop. A
 * refused call answers a tool error (`isError: true`) saying when to retry,
 * not an HTTP 429: Claude Code and Codex hand a tool error's text to their
 * model, which can wait and retry, while a non-2xx answer to `tools/call` is a
 * transport failure that they surface as the server failing.
 *
 * Audit: one `audit_log` row per call that ran (object `mcp_tool`, action
 * `called`): who, which client, which tool, what it acted on (agent, drive,
 * session) and whether it succeeded. Never the arguments themselves: no
 * prompt, question, file name or content, token or URL. A call refused by
 * the rate limit writes no row, so a flood cannot fill the audit log.
 */
import { defineFixedWindow } from '@shared/lib/app-state/fixed-window'
import { logAuditEvent } from '@shared/lib/services/audit-log-service'
import type { McpCallContext } from './context'
import type { McpAuditTarget } from './tool-definition'

export const MCP_TOOL_CALLS_PER_MINUTE = 120

export const mcpToolCalls = defineFixedWindow({ name: 'rate:mcp-tool-calls', limit: MCP_TOOL_CALLS_PER_MINUTE, windowMs: 60_000 })

export type ToolCallAdmission = { admitted: true } | { admitted: false; retryAfterSeconds: number }

/** Counts the call against the person's window. An AppState failure throws: the call fails rather than running uncounted. */
export async function admitToolCall(userId: string): Promise<ToolCallAdmission> {
  const hit = await mcpToolCalls.hit(mcpToolCalls.key(userId))
  if (hit.admitted) return { admitted: true }
  return { admitted: false, retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - Date.now()) / 1000)) }
}

export function rateLimitedMessage(retryAfterSeconds: number): string {
  return `Rate limit: at most ${MCP_TOOL_CALLS_PER_MINUTE} Gamut tool calls a minute. Nothing was done. Wait ${retryAfterSeconds} seconds, then call again.`
}

/** What a call's arguments name, before the tool says more. */
export function auditTargetOf(args: unknown): McpAuditTarget {
  if (!args || typeof args !== 'object') return {}
  const record = args as Record<string, unknown>
  const pick = (key: string) => (typeof record[key] === 'string' ? (record[key] as string).slice(0, 256) : undefined)
  const target: McpAuditTarget = {}
  const agent = pick('agent')
  const drive = pick('drive')
  const sessionId = pick('session_id')
  if (agent) target.agent = agent
  if (drive) target.drive = drive
  if (sessionId) target.sessionId = sessionId
  return target
}

export function auditToolCall(params: {
  ctx: McpCallContext
  tool: string
  clientName: string | null
  target: McpAuditTarget
  outcome: 'ok' | 'error'
}): Promise<void> {
  const { ctx, tool, clientName, target, outcome } = params
  // Written in the background (logAuditEvent): the row never holds the answer.
  return logAuditEvent({
    userId: ctx.userId,
    object: 'mcp_tool',
    objectId: target.agent ?? target.drive ?? tool,
    action: 'called',
    details: {
      tool,
      client: clientName,
      credential: ctx.credential.kind,
      ...(target.agent ? { agent: target.agent } : {}),
      ...(target.drive ? { drive: target.drive } : {}),
      ...(target.sessionId ? { session_id: target.sessionId } : {}),
      outcome,
    },
  })
}
