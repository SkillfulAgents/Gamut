/**
 * Whether `/mcp` answers: the admin's switch in settings, else the mode's
 * default. Without auth mode the installation token already gates the
 * endpoint, so it is on; in auth mode an admin decides for the workspace, so
 * it starts off (and the route is not served there at all until OAuth lands).
 */
import { isAuthMode } from '@shared/lib/auth/mode'
import { getSettings, updateSettings, type AppSettings } from '@shared/lib/config/settings'
import type { McpServerReach } from './mcp-server-settings-schema'

export function defaultMcpServerEnabled(): boolean {
  return !isAuthMode()
}

export function isMcpServerEnabledFrom(settings: Pick<AppSettings, 'mcpServer'>): boolean {
  return settings.mcpServer?.enabled ?? defaultMcpServerEnabled()
}

export async function isMcpServerEnabled(): Promise<boolean> {
  return isMcpServerEnabledFrom(await getSettings())
}

/** Set the switch. `changed` is false when it already was so: nothing is written. */
export async function setMcpServerEnabled(enabled: boolean): Promise<{ enabled: boolean; changed: boolean }> {
  const { after, written } = await updateSettings((draft, before) => {
    if (isMcpServerEnabledFrom(before) === enabled) return false
    draft.mcpServer = { ...draft.mcpServer, enabled }
  })
  return { enabled: isMcpServerEnabledFrom(after), changed: written }
}

/** Who can reach `/mcp` where the server checks request sources; `this-computer` unless an admin chose otherwise. */
export function mcpServerReachFrom(settings: Pick<AppSettings, 'mcpServer'>): McpServerReach {
  return settings.mcpServer?.reach ?? 'this-computer'
}

/** Set who can reach `/mcp`. `changed` is false when it already was so: nothing is written. */
export async function setMcpServerReach(reach: McpServerReach): Promise<{ reach: McpServerReach; changed: boolean }> {
  const { after, written } = await updateSettings((draft, before) => {
    if (mcpServerReachFrom(before) === reach) return false
    draft.mcpServer = { ...draft.mcpServer, reach }
  })
  return { reach: mcpServerReachFrom(after), changed: written }
}
