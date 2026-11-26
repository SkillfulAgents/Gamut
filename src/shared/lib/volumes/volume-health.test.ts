import { afterEach, describe, expect, it, vi } from 'vitest'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { volumeProblem } from './volume-health'

const noteDriveHealth = vi.fn()
vi.mock('@shared/lib/agent-actor/registry', () => ({
  isAgentRegistryInitialized: () => true,
  agentRegistry: { held: () => [{ slug: 'agent-a', container: { noteDriveHealth } }] },
}))
vi.mock('@shared/lib/notifications/global-feed', () => ({ globalFeed: { publish: vi.fn() } }))

const mount = { id: 'mount-1', volumeId: 'drive-1', name: 'notes', type: 'local' as const, config: { path: '/nowhere' } }

afterEach(() => vi.clearAllMocks())

describe('volumeProblem', () => {
  it('tells the agent a read made as it, and refreshes the agent when its missing drives changed', async () => {
    noteDriveHealth.mockResolvedValue(true)
    const reason = await volumeProblem(mount, 'agent-a')
    await vi.waitFor(() => expect(globalFeed.publish).toHaveBeenCalledWith({ type: 'agent_updated', agentSlug: 'agent-a' }))
    expect(noteDriveHealth).toHaveBeenCalledExactlyOnceWith('drive-1', reason)
  })

  it('refreshes no window when the read changed nothing for the agent', async () => {
    noteDriveHealth.mockResolvedValue(false)
    const reason = await volumeProblem(mount, 'agent-a')
    await vi.waitFor(() => expect(noteDriveHealth).toHaveBeenCalledWith('drive-1', reason))
    expect(globalFeed.publish).not.toHaveBeenCalled()
  })
})
