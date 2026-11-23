/**
 * Whether `/mcp` answers: the admin's switch in settings, else the mode's
 * default. Without auth mode the installation token already gates the
 * endpoint, so it is on; in auth mode an admin decides for the workspace, so
 * it starts off (and the route is not served there at all until OAuth lands).
 */
import { isAuthMode } from '@shared/lib/auth/mode'
import { getSettings, mutateSettings, type AppSettings } from '@shared/lib/config/settings'
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

export async function setMcpServerEnabled(enabled: boolean): Promise<boolean> {
  const settings = await mutateSettings((draft) => {
    draft.mcpServer = { ...draft.mcpServer, enabled }
  })
  return isMcpServerEnabledFrom(settings)
}

/** Who can reach `/mcp` where the server checks request sources; `this-computer` unless an admin chose otherwise. */
export function mcpServerReachFrom(settings: Pick<AppSettings, 'mcpServer'>): McpServerReach {
  return settings.mcpServer?.reach ?? 'this-computer'
}

export async function setMcpServerReach(reach: McpServerReach): Promise<McpServerReach> {
  const settings = await mutateSettings((draft) => {
    draft.mcpServer = { ...draft.mcpServer, reach }
  })
  return mcpServerReachFrom(settings)
}
