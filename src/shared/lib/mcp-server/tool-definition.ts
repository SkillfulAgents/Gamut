/**
 * How a tool is declared. A tool module exports `McpToolDefinition`s and the
 * registry (registry.ts) collects them.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { McpCallContext } from './context'

/** What a tool needs of the caller's grant: reading, or making agents act (OAuth scopes `gamut:read` / `gamut:run`). */
export type McpToolScope = 'read' | 'run'

/** Clients show tool names in places that cut long ones; the spec's limit. */
export const MAX_TOOL_NAME_LENGTH = 64

/**
 * One tool call as the tool sees it, beyond its arguments: the client's
 * cancellation, a way to report progress while it waits, the client's name,
 * and where the call's audit row points.
 */
export interface McpToolCall {
  /** Aborts when the client cancels the call or goes away. */
  signal: AbortSignal
  /**
   * Sends an MCP progress notification when the client asked for progress
   * (sent a progress token); a no-op otherwise. Never throws.
   */
  progress(progress: number, total: number | undefined, message: string): Promise<void>
  /** The client's own name from MCP `clientInfo`, or null when its era does not carry it per request. */
  clientName: string | null
  /** Names what the call acted on, for its audit row, when the arguments alone do not say (ask_team_brain). */
  setAuditTarget(target: McpAuditTarget): void
}

/** What a tool call acted on, as its audit row names it. */
export interface McpAuditTarget {
  agent?: string
  drive?: string
  sessionId?: string
}

/** A call with no client behind it (tests, a tool calling another): no progress, never aborted. */
export function detachedCall(overrides: Partial<McpToolCall> = {}): McpToolCall {
  return {
    signal: new AbortController().signal,
    progress: async () => {},
    clientName: null,
    setAuditTarget: () => {},
    ...overrides,
  }
}

export interface McpToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  scope: McpToolScope
  input: I
  output: O
  annotations: Omit<ToolAnnotations, 'title'>
  handler(args: z.output<I>, ctx: McpCallContext, call: McpToolCall): Promise<z.input<O>>
}

/** Declares a tool with its types inferred from its schemas. */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(definition: McpToolDefinition<I, O>): McpToolDefinition<I, O> {
  return definition
}

/** The annotations of a tool that only reads. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies Omit<ToolAnnotations, 'title'>
