import type { NotMountedReason, StoredVolume, VolumeSummary, VolumeSummaryWithHealth } from '@shared/lib/types/mount'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { VolumePreparingError } from './volume-error'
import { instantiateVolume } from './volume-factory'
import { LocalMountableVolume } from './local-mountable-volume'
import { background } from '@shared/lib/background'
import { globalFeed } from '@shared/lib/notifications/global-feed'

export function volumeSummary(row: StoredVolume): VolumeSummary {
  const volume = instantiateVolume(row)
  return {
    id: row.id, name: row.name, type: row.type, hostPath: volume?.hostPath ?? null,
    ...(volume?.sourceLabel ? { sourceLabel: volume.sourceLabel } : {}),
    ...(volume?.readOnly ? { sourceReadOnly: true } : {}),
    ...(volume?.attention ? { attention: volume.attention } : {}),
  }
}

/** A preparing reason that carries an error is a failed first copy, so it reads as missing. */
export function volumeHealth(reason: NotMountedReason | null): VolumeSummaryWithHealth['health'] {
  return reason === null ? 'ok' : reason === 'preparing' ? 'preparing' : 'missing'
}

/** A read made as an agent tells that agent, so one that started without this drive learns when it changes. */
export async function volumeProblem(row: StoredVolume & { volumeId?: string }, agentSlug?: string): Promise<NotMountedReason | null> {
  const reason = await currentProblem(row, agentSlug)
  // Only a read as the agent answers for it: without a slug, a drive acts as the signed-in person.
  if (agentSlug && row.volumeId) background(tellAgent(agentSlug, row.volumeId, reason), { name: 'volume-health.tell-agent' })
  return reason
}

async function tellAgent(agentSlug: string, driveId: string, reason: NotMountedReason | null): Promise<void> {
  // Imported here: the registry loads the container runtime, which loads this module.
  const { agentRegistry, isAgentRegistryInitialized } = await import('@shared/lib/agent-actor/registry')
  // A process that reads drives without running agents (a script, a unit test) has nobody to tell.
  if (!isAgentRegistryInitialized()) return
  // Only an agent the app holds: one deleted meanwhile is not made again.
  const agent = agentRegistry.held().find((held) => held.slug === agentSlug)
  if (await agent?.container.noteDriveHealth(driveId, reason)) globalFeed.publish({ type: 'agent_updated', agentSlug })
}

async function currentProblem(row: StoredVolume, agentSlug?: string): Promise<NotMountedReason | null> {
  if (!row.name || row.name === '.' || row.name === '..' || /[/\\\0]/.test(row.name)) return 'invalid name'
  const volume = instantiateVolume(row, agentSlug)
  if (!volume) return 'unreadable'
  // The sandbox lost the folder: nothing to fix in it, only the pick to make again.
  if (volume instanceof LocalMountableVolume && !volume.opens()) return 'pick the folder again'
  try {
    return (await volume.health()).kind === 'directory' ? null : 'not found'
  } catch (error) {
    if (error instanceof VolumePreparingError) return error.reason ? `preparing: ${error.reason}` : 'preparing'
    if (error instanceof WorkspaceFileError && error.code === 'not-found') return 'not found'
    if (error instanceof WorkspaceFileError && error.code === 'not-accessible') return 'not accessible'
    return 'unreadable'
  }
}
