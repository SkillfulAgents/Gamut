/**
 * The questions asked of every agent at once, answered through the registry
 * and each agent's actor: nothing here knows how an agent runs its container.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAgentRegistryForTest, agentRegistry } from './registry'
import { agentsHoldingDrives, hasRunningAgents, markRunningAgentsStale, runningAgentSlugs, stopAllAgents, wakeAgents } from './all-agents'
import type { AgentActor } from './types'

type Status = 'running' | 'stopped'

/** An actor that answers only what these questions ask of it. */
function fakeActor(slug: string, status: Status) {
  const container = {
    status: vi.fn(async () => ({ status: actor.status, port: actor.status === 'running' ? 4000 : null })),
    holdsDrives: vi.fn(async (_options?: { orStarting?: boolean }) => actor.status === 'running'),
    invalidate: vi.fn(async () => 'marked-stale' as const),
    stop: vi.fn(async () => {
      actor.status = 'stopped'
    }),
  }
  const actor = { slug, status, container, ready: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  return actor
}

let actors: Map<string, ReturnType<typeof fakeActor>>
/** Makes the agents the process holds: a slug not listed gets a stopped actor on first use. */
function hold(...made: Array<ReturnType<typeof fakeActor>>) {
  actors = new Map(made.map((actor) => [actor.slug, actor]))
  _resetAgentRegistryForTest((slug) => {
    let actor = actors.get(slug)
    if (!actor) {
      actor = fakeActor(slug, 'stopped')
      actors.set(slug, actor)
    }
    return actor as unknown as AgentActor
  })
  for (const actor of made) agentRegistry.get(actor.slug)
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  _resetAgentRegistryForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('which agents run', () => {
  it('nothing runs when the process holds no agent, or only stopped ones', async () => {
    hold()
    expect(await hasRunningAgents()).toBe(false)
    expect(await runningAgentSlugs()).toEqual([])

    hold(fakeActor('agent-1', 'stopped'), fakeActor('agent-2', 'stopped'))
    expect(await hasRunningAgents()).toBe(false)
    expect(await runningAgentSlugs()).toEqual([])
  })

  it('names the agents whose actors see their container running', async () => {
    hold(fakeActor('agent-1', 'stopped'), fakeActor('agent-2', 'running'), fakeActor('agent-3', 'running'))
    expect(await hasRunningAgents()).toBe(true)
    expect((await runningAgentSlugs()).sort()).toEqual(['agent-2', 'agent-3'])
  })

  it('follows what each actor sees now', async () => {
    const agent = fakeActor('agent-1', 'running')
    hold(agent)
    expect(await runningAgentSlugs()).toEqual(['agent-1'])
    agent.status = 'stopped'
    expect(await runningAgentSlugs()).toEqual([])
  })

  it('asks only the actors the process holds, and makes none', async () => {
    hold(fakeActor('agent-1', 'running'))
    await runningAgentSlugs()
    expect([...actors.keys()]).toEqual(['agent-1'])
  })

  it('forgets an agent once it is evicted', async () => {
    hold(fakeActor('agent-1', 'running'))
    await agentRegistry.evict('agent-1')
    expect(await hasRunningAgents()).toBe(false)
  })
})

describe('agentsHoldingDrives', () => {
  it('names the agents whose actors say a drive change needs a restart, passing the option on', async () => {
    const running = fakeActor('a', 'running')
    const starting = fakeActor('b', 'stopped')
    starting.container.holdsDrives.mockImplementation(async (options) => options?.orStarting === true)
    hold(running, starting, fakeActor('c', 'stopped'))

    expect(await agentsHoldingDrives()).toEqual(['a'])
    expect((await agentsHoldingDrives({ orStarting: true })).sort()).toEqual(['a', 'b'])
  })
})

describe('markRunningAgentsStale', () => {
  it('marks every running agent through its actor, and leaves the stopped ones alone', async () => {
    const a = fakeActor('a', 'running')
    const b = fakeActor('b', 'running')
    const c = fakeActor('c', 'stopped')
    hold(a, b, c)

    await markRunningAgentsStale()

    expect(a.container.invalidate).toHaveBeenCalledOnce()
    expect(b.container.invalidate).toHaveBeenCalledOnce()
    // Never asked to restart: the user does that.
    expect(a.container.invalidate).toHaveBeenCalledWith()
    expect(c.container.invalidate).not.toHaveBeenCalled()
  })
})

describe('wakeAgents', () => {
  it('makes every agent\'s actor, and waits until each has read its container', async () => {
    hold()
    // The actor `wake-1` gets when it is made: its first read is still out.
    let landRead!: () => void
    const slow = fakeActor('wake-1', 'running')
    slow.ready.mockImplementation(() => new Promise<void>((resolve) => { landRead = resolve }))
    actors.set('wake-1', slow)

    const done = vi.fn()
    const waking = wakeAgents(['wake-1', 'wake-2']).then(done)
    expect(agentRegistry.held().map((actor) => actor.slug).sort()).toEqual(['wake-1', 'wake-2'])
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).not.toHaveBeenCalled()

    landRead()
    await waking
    expect(done).toHaveBeenCalledOnce()
    expect(actors.get('wake-2')!.ready).toHaveBeenCalledOnce()
  })
})

describe('stopAllAgents', () => {
  it('stops the running agents through their actors, and only those', async () => {
    const a = fakeActor('agent-1', 'running')
    const b = fakeActor('agent-2', 'running')
    const c = fakeActor('agent-3', 'stopped')
    hold(a, b, c)

    await stopAllAgents()

    expect(a.container.stop).toHaveBeenCalledOnce()
    expect(b.container.stop).toHaveBeenCalledOnce()
    expect(c.container.stop).not.toHaveBeenCalled()
    expect(await hasRunningAgents()).toBe(false)
  })

  it.each(['status', 'stop'] as const)('still stops the other agents when one %s call fails', async (operation) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = fakeActor('agent-1', 'running')
    const b = fakeActor('agent-2', 'running')
    a.container[operation].mockRejectedValueOnce(new Error('connection refused'))
    hold(a, b)

    await expect(stopAllAgents()).resolves.toBeUndefined()
    expect(b.container.stop).toHaveBeenCalledOnce()
  })

  it('stops healthy agents immediately and ignores a status reply after the deadline', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const slow = fakeActor('slow-agent', 'running')
    const fast = fakeActor('fast-agent', 'running')
    slow.container.status.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve({ status: 'running', port: 4000 }), 60_000)
    }))
    hold(slow, fast)

    const done = vi.fn()
    const stopping = stopAllAgents().then(done)
    await vi.advanceTimersByTimeAsync(0)
    expect(fast.container.stop).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(50_000)
    expect(done).toHaveBeenCalledOnce()
    await stopping

    await vi.advanceTimersByTimeAsync(10_000)
    expect(slow.container.stop).not.toHaveBeenCalled()
  })

  it('shares one deadline between reading status and stopping the container', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const slow = fakeActor('slow-agent', 'running')
    slow.container.status.mockImplementationOnce(() => new Promise(resolve => {
      setTimeout(() => resolve({ status: 'running', port: 4000 }), 10_000)
    }))
    slow.container.stop.mockImplementation(() => new Promise<void>(() => {}))
    hold(slow)

    const done = vi.fn()
    const stopping = stopAllAgents().then(done)
    await vi.advanceTimersByTimeAsync(49_000)
    expect(slow.container.stop).toHaveBeenCalledOnce()
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(done).toHaveBeenCalledOnce()
    await stopping
  })
})
