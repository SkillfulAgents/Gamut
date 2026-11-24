import { describe, expect, it, vi } from 'vitest'
import { BaseAgentActor } from '@shared/lib/agent-actor/base-agent-actor'
import { createRecordingHostPort } from '@shared/lib/agent-actor/testing/recording-host-port'
import { taskManager } from '@shared/lib/background-work'
import type { AgentDurableObject } from './cloudflare-agent'
import { CloudflareAgentActorDO, type CloudflareAgentActorDOParts } from './cloudflare-agent-actor-do'
import { PurgeWorkspaceTask } from '../lib/purge-workspace-task'
import type { Env } from '../index'

/** The agent's object, as far as its actor uses it. */
function agentObject() {
  return {
    scheduleIdleCheckBy: vi.fn(),
    cancelIdleCheck: vi.fn(async () => {}),
    agentRunning: vi.fn(async () => false),
    sessionIndexSql: vi.fn(),
  }
}

function actorIn(object: ReturnType<typeof agentObject>): CloudflareAgentActorDO {
  const parts = {
    // A container layer whose agents have no container running.
    containers: {
      createRuntime: () => ({
        isStopping: () => false,
        isStarting: () => false,
        syncAgentStatus: async () => ({ status: 'stopped', port: null }),
        getCachedInfo: () => ({ status: 'stopped', port: null }),
        getClient: async () => ({ isDefinitelyStopped: async () => true }),
        dispose: () => {},
      }),
    },
    host: createRecordingHostPort().port,
    object: object as unknown as AgentDurableObject,
    env: { AGENT: {} } as unknown as Env,
  } as unknown as CloudflareAgentActorDOParts
  return new CloudflareAgentActorDO('sales-agent', parts)
}

/** The members a subclass gives the base actor, which only the base calls. */
type IdleWake = { wakeToCheckIdleAt(at: number): void; cancelIdleWake(): void }

describe('CloudflareAgentActorDO', () => {
  it("is the base actor, kept in the agent's object", async () => {
    const actor = actorIn(agentObject())
    await actor.ready()

    expect(actor).toBeInstanceOf(BaseAgentActor)
    expect(actor.store.key).toBe('cloudflare:sales-agent')
    await actor.dispose()
  })

  it("wakes to check whether its container is idle on the object's alarm", async () => {
    const object = agentObject()
    const actor = actorIn(object)
    await actor.ready()
    const wake = actor as unknown as IdleWake

    wake.wakeToCheckIdleAt(1_800_000)
    wake.cancelIdleWake()

    expect(object.scheduleIdleCheckBy).toHaveBeenCalledWith(1_800_000)
    expect(object.cancelIdleCheck).toHaveBeenCalledOnce()
    await actor.dispose()
  })

  it('deletes what it stored through the purge task, which the task manager tries again', async () => {
    const purge = vi.fn(async (_slug: string) => {})
    taskManager().register(new PurgeWorkspaceTask(purge))
    const actor = actorIn(agentObject())
    await actor.ready()

    await actor.delete()

    await vi.waitFor(() => expect(purge).toHaveBeenCalledWith('sales-agent'))
    await actor.dispose()
  })
})
