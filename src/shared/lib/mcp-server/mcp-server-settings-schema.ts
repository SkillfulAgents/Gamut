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
  /** False where `/mcp` cannot be served: an auth-mode deployment that is not on https. */
  available: boolean
  /** Why not, when not available. */
  unavailableReason: string | null
  /** How clients connect: the installation token (no auth mode) or OAuth sign-in (auth mode). */
  auth: 'installation-token' | 'oauth'
  enabled: boolean
  /** The endpoint as the request reached this server (the Electron port can move). */
  endpointUrl: string
  /** The installation token; null in auth mode, which has none. */
  token: string | null
}

/** `POST /api/mcp-server/oauth/clients/revoke`. */
export const revokeMcpClientRequestSchema = z.object({ clientId: z.string().min(1).max(2048) }).strict()
