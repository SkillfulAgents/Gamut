import { z } from 'zod'

/** A session the caller successfully started or continued. */
export const invokedSessionSchema = z.object({
  toolUseId: z.string().optional(),
  agentSlug: z.string(),
  sessionId: z.string(),
  prompt: z.string(),
  calledAt: z.string(),
})
export type InvokedSession = z.infer<typeof invokedSessionSchema>

export const INVOKE_AGENT_TOOL = 'mcp__agents__invoke_agent'

/** The two-line header that older containers wrote ahead of the agent's arbitrary response text. */
export function invokedSessionResult(result: unknown): { sessionId: string; status: string } | undefined {
  // MCP returns text blocks. Old exports may have serialized the same array as JSON.
  if (typeof result === 'string' && result.startsWith('[')) {
    try { result = JSON.parse(result) } catch { return undefined }
  }
  if (Array.isArray(result)) result = result.find(block => block?.type === 'text')?.text
  if (typeof result !== 'string') return undefined
  const header = /^session_id: ([^\s/]+)\r?\nstatus: ([^\s]+)(?:\s|$)/.exec(result)
  return header ? { sessionId: header[1], status: header[2] } : undefined
}
