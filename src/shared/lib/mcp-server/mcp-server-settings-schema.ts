import { z } from 'zod'

/**
 * `settings.mcpServer`: the admin's switch for the `/mcp` endpoint. Absent
 * means the mode's default (`isMcpServerEnabledFrom`).
 */
export const mcpServerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
}).strict()

export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>

/** What `GET /api/mcp-server` answers (Settings → MCP Server). */
export interface McpServerStatusResponse {
  /** False where `/mcp` is not served yet (auth mode, until OAuth lands). */
  available: boolean
  enabled: boolean
  /** The endpoint as the request reached this server (the Electron port can move). */
  endpointUrl: string
  /** The installation token; null in auth mode, which has none. */
  token: string | null
}
