import { z } from 'zod'

/**
 * `settings.mcpServer`: the admin's switch for the `/mcp` endpoint. Absent
 * means the mode's default (`isMcpServerEnabledFrom`).
 */
export const MCP_SERVER_REACHES = ['this-computer', 'network'] as const
export const mcpServerReachSchema = z.enum(MCP_SERVER_REACHES)
/**
 * Who can reach `/mcp` where the server checks request sources (the desktop
 * app): requests from this machine only, or from other devices on the network
 * too. Absent means `this-computer`.
 */
export type McpServerReach = z.infer<typeof mcpServerReachSchema>

export const mcpServerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  reach: mcpServerReachSchema.optional(),
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
  reach: {
    /** Whether this server checks where requests come from (the desktop app); elsewhere the infrastructure decides. */
    applies: boolean
    value: McpServerReach
    /** This machine's non-internal IPv4 addresses, which other devices use in `network` mode; empty where `applies` is false. */
    networkAddresses: string[]
  }
}
