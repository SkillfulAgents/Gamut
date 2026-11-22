/**
 * What every tool returns: the JSON as text (the portable surface every
 * client reads) and the same value as `structuredContent`, or a tool error
 * whose text says what to do next. Results stay under a character budget so
 * one call never crowds a client's context (Claude Code caps a tool result at
 * 25,000 tokens by default).
 */
import type { CallToolResult } from '@modelcontextprotocol/server'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumeError } from '@shared/lib/volumes/volume-error'
import { SignedFileUrlError } from '@shared/lib/signed-file-urls/signed-file-urls'
import { captureException } from '@shared/lib/error-reporting'

/**
 * The most characters of JSON one result carries: about 15,000 tokens at
 * four characters a token, under the ~20,000-token target with room for the
 * client's own framing.
 */
export const MAX_RESULT_CHARS = 60_000

/** A refusal or failure whose message is meant for the calling agent. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}

export function jsonResult<T extends Record<string, unknown>>(value: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  }
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** The text an error becomes; unexpected ones are reported and say only that the call failed. */
export function errorMessage(error: unknown, toolName: string): string {
  if (error instanceof McpToolError) return error.message
  if (error instanceof VolumeError) {
    return error.status === 404
      ? 'Drive not found, or you cannot see it. Call list_drives for the drives you can read.'
      : `The drive could not be read: ${error.message}`
  }
  if (error instanceof WorkspaceFileError) {
    if (error.code === 'not-found') return 'No file or folder at that path. Call list_drive_files on its parent folder to see what is there.'
    if (error.code === 'not-a-file') return 'That path is a folder. Call list_drive_files to list it.'
    if (error.code === 'not-a-directory') return 'That path is a file, not a folder. Call read_drive_file to read it.'
    return error.message
  }
  if (error instanceof SignedFileUrlError) return `Could not prepare a download link: ${error.message}`
  console.error(`[mcp-server] ${toolName} failed:`, error)
  captureException(error, { tags: { component: 'mcp-server', operation: toolName } })
  return `${toolName} failed inside Gamut. Try again; if it keeps failing, the person running Gamut can check its logs.`
}

/** Runs a tool body, turning any error into a tool error with actionable text. */
export async function runTool(toolName: string, body: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body()
  } catch (error) {
    return errorResult(errorMessage(error, toolName))
  }
}

/**
 * The longest prefix of `items` whose JSON fits `budget` characters (at least
 * one item, so a page always makes progress; a caller keeps single items
 * small). Returns how many fit.
 */
export function countFitting(items: readonly unknown[], budget: number): number {
  let used = 0
  for (let index = 0; index < items.length; index++) {
    used += JSON.stringify(items[index]).length + 1
    if (used > budget) return Math.max(1, index)
  }
  return items.length
}

/** Cut `text` to `max` characters, saying so. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: `${text.slice(0, max)}\n[… truncated: ${text.length - max} more characters]`, truncated: true }
}
