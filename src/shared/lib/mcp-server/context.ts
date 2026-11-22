/**
 * Who one MCP request acts for, built once per request by the endpoint's
 * authentication step and handed to every tool. Nothing in it outlives the
 * request: the endpoint is stateless, and a request served by another process
 * builds its own.
 */
import { isAuthMode } from '@shared/lib/auth/mode'
import { userXAgentCaller, type UserXAgentCaller } from '@shared/lib/services/x-agent/caller'
import type { VolumeViewer } from '@shared/lib/services/volume-service'
import type { McpToolScope } from './tool-definition'

/** How the request was authenticated. The OAuth PR adds its own kind. */
export type McpCredential = { kind: 'installation-token' }

export interface McpCallContext {
  /** The person the call acts for: `local` without auth mode. */
  userId: string
  /** A platform admin passes every agent role check, as in the app. */
  isAdmin: boolean
  /** Where a client reaches this app (no trailing slash), for links handed out. */
  publicBaseUrl: string
  credential: McpCredential
  /**
   * What the credential grants: `read`, and `run` to make agents act. The
   * installation token grants both; an OAuth token grants what its scopes say.
   */
  scopes: readonly McpToolScope[]
}

/** The x-agent service's caller for this person (role checks, no agent policy). */
export function xAgentCallerFor(ctx: McpCallContext): UserXAgentCaller {
  return userXAgentCaller({ userId: ctx.userId, isAdmin: ctx.isAdmin })
}

/** The drive viewer the drive routes build for this person (api/lib/volume-access.ts). */
export function volumeViewerFor(ctx: McpCallContext): VolumeViewer {
  return isAuthMode() ? { userId: ctx.userId, admin: ctx.isAdmin } : { userId: null, admin: true }
}
