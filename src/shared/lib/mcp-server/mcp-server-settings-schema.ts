import { z } from 'zod'

/**
 * `settings.mcpServer`: the admin's switch for the `/mcp` endpoint. Absent
 * means the mode's default (`isMcpServerEnabledFrom`).
 */
export const mcpServerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
}).strict()

export type McpServerSettings = z.infer<typeof mcpServerSettingsSchema>
