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

export interface McpToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodObject = z.ZodObject> {
  name: string
  title: string
  description: string
  scope: McpToolScope
  input: I
  output: O
  annotations: Omit<ToolAnnotations, 'title'>
  handler(args: z.output<I>, ctx: McpCallContext): Promise<z.input<O>>
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
