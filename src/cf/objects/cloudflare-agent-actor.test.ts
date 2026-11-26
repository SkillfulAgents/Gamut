import { describe, expect, it, vi } from 'vitest'
import { WorkspaceFileError } from '@shared/lib/agent-actor/workspace-path'
import { ACTOR_GROUPS, type AgentActor } from '@shared/lib/agent-actor/types'
import { requestScopedSettings } from '@shared/lib/config/settings-request-memo'
import { getRequestUserId, runOutsideRequestUser, runWithRequestUser } from '@shared/lib/platform-attribution/request-context'
import type { AgentDurableObject } from './cloudflare-agent'
import type { CloudflareAgentActorDO } from './cloudflare-agent-actor-do'
import type { Env } from '../index'
import { CloudflareAgentActor, runActorOp, runAsAgentObject, servingAgentObject, type ActorObject } from './cloudflare-agent-actor'
import { evictObjectActor, objectActor } from './object-actors'

/** The deployment's bindings, whose agent objects all answer as `object` does. */
const reaching = (object: ActorObject) => ({ AGENT: { getByName: () => object } }) as unknown as Pick<Env, 'AGENT' | 'VERSION'>

/** The actor in the agent's object, reached the way RPC reaches it: arguments and results are cloned, and the caller's async context stays behind. */
function overRpc(actor: Partial<Record<string, unknown>>) {
  const calls: Array<{ path: string; args: unknown[] }> = []
  const object: ActorObject = {
    actorCall: async (path, args, _callerVersion, actingUserId) => {
      calls.push({ path, args })
      const cloned = path === 'container.fetch' ? args : structuredClone(args)
      const outcome = await runOutsideRequestUser(() => runActorOp(actor as unknown as AgentActor, path, cloned, actingUserId))
      if (path === 'container.fetch') return outcome
      // A stream crosses RPC only when it is a byte stream; it is transferred, not cloned.
      if ('value' in outcome && outcome.value instanceof ReadableStream) {
        outcome.value.getReader({ mode: 'byob' }).releaseLock()
        return outcome
      }
      return structuredClone(outcome)
    },
  }
  return { client: new CloudflareAgentActor('sales-agent', reaching(object)), calls }
}

describe('CloudflareAgentActor', () => {
  it("runs an op on the agent's actor and gets its value back, dates and maps included", async () => {
    const lastActivityAt = new Date('2026-11-06T18:00:00Z')
    const { client } = overRpc({ sessions: { summary: async () => ({ sessionIds: ['s1'], sessionCount: 1, lastActivityAt, byDay: new Map([['2026-11-06', 3]]) }) } })

    const summary = (await client.sessions.summary()) as unknown as { lastActivityAt: Date; byDay: Map<string, number> }

    expect(summary.lastActivityAt).toEqual(lastActivityAt)
    expect(summary.byDay.get('2026-11-06')).toBe(3)
  })

  it("runs the actor's own calls, which belong to no group: its live state and its list entry", async () => {
    const live = vi.fn(async () => ({ containerStatus: 'running' }))
    const listing = vi.fn(async () => ({ sessionCount: 2, lastActivityAt: new Date('2026-11-06T18:00:00Z') }))
    const { client, calls } = overRpc({ live, listing })

    expect(await client.live()).toEqual({ containerStatus: 'running' })
    expect(await client.listing()).toEqual({ sessionCount: 2, lastActivityAt: new Date('2026-11-06T18:00:00Z') })
    expect(calls.map((call) => call.path)).toEqual(['live', 'listing'])
  })

  it('reaches ops in nested groups', async () => {
    const withdraw = vi.fn(async () => 'withdrawn')
    const { client, calls } = overRpc({ inputs: { reviews: { withdraw } } })

    expect(await (client.inputs.reviews.withdraw as unknown as (id: string) => Promise<string>)('review-1')).toBe('withdrawn')
    expect(withdraw).toHaveBeenCalledWith('review-1')
    expect(calls[0].path).toBe('inputs.reviews.withdraw')
  })

  it('keeps the class of an error the actor throws, so callers can still branch on it', async () => {
    const { client } = overRpc({ files: { getDoc: async () => { throw new WorkspaceFileError('not-found') } } })

    const error = await client.files.getDoc('notes/q3.md').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(WorkspaceFileError)
    expect((error as WorkspaceFileError).code).toBe('not-found')
  })

  it('leaves an AbortSignal behind, since it cannot cross RPC', async () => {
    const page = vi.fn(async () => ({ messages: [] }))
    const { client, calls } = overRpc({ messages: { page } })

    await client.messages.page('s1', { limit: 50, signal: new AbortController().signal } as never)

    expect(calls[0].args).toEqual(['s1', { limit: 50 }])
  })

  it("passes container.fetch's method, headers and body through, and returns the container's response", async () => {
    const fetch = vi.fn(async (path: string, init?: RequestInit) => new Response(`${init?.method} ${path} ${await new Response(init?.body).text()} ${new Headers(init?.headers).get('x-agent')}`))
    const { client } = overRpc({ container: { fetch } })

    const response = await client.container.fetch('/files/notes.md/upload', { method: 'POST', headers: { 'x-agent': 'sales' }, body: 'Q3 pipeline' })

    expect(await response.text()).toBe('POST /files/notes.md/upload Q3 pipeline sales')
  })

  it("sends a viewer's frames as a byte stream and hands them back as frames", async () => {
    const frames = [{ id: '1', data: '{"type":"snapshot"}' }, { id: '2', data: '{"type":"ping"}' }]
    const { client } = overRpc({ messages: { follow: async () => new ReadableStream({ start: (controller) => { for (const frame of frames) controller.enqueue(frame); controller.close() } }) } })

    const stream = await client.messages.follow('s1', {})

    expect(await Array.fromAsync(stream as unknown as AsyncIterable<unknown>)).toEqual(frames)
  })

  it("cancels the agent's stream when the viewer stops reading", async () => {
    const cancel = vi.fn()
    const { client } = overRpc({ messages: { subscribe: async () => new ReadableStream({ pull: (controller) => controller.enqueue({ type: 'ping' }), cancel }) } })

    const stream = await client.messages.subscribe('s1')
    const reader = stream.getReader()
    expect(await reader.read()).toEqual({ done: false, value: { type: 'ping' } })
    await reader.cancel()

    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it("runs the op for the user the caller's request acts for, and for no user when the caller has none", async () => {
    const { client } = overRpc({ sessions: { summary: async () => getRequestUserId() ?? null } })

    expect(await runWithRequestUser('user-1', () => client.sessions.summary())).toBe('user-1')
    expect(await client.sessions.summary()).toBeNull()
  })

  it("shares one settings read between an op's readers, and reads again for the next op", async () => {
    let reads = 0
    const read = async () => ({ read: ++reads })
    const { client } = overRpc({ sessions: { summary: async () => [await requestScopedSettings(read), await requestScopedSettings(read)] } })

    expect(await client.sessions.summary()).toEqual([{ read: 1 }, { read: 1 }])
    expect(await client.sessions.summary()).toEqual([{ read: 2 }, { read: 2 }])
  })

  it('sends every op to the object under its own path, and dispose never', async () => {
    const paths: string[] = []
    const object: ActorObject = { actorCall: async (path) => { paths.push(path); return { value: path === 'messages.follow' || path === 'messages.subscribe' ? new ReadableStream({ type: 'bytes', start: (c) => c.close() }) : undefined } } }
    const client = new CloudflareAgentActor('sales-agent', reaching(object))
    const expected: string[] = []
    const callAll = async (owner: object, prefix: string): Promise<void> => {
      for (const [name, member] of Object.entries(owner)) {
        if (typeof member === 'function') {
          expected.push(`${prefix}${name}`)
          await (member as () => Promise<unknown>)()
        } else {
          await callAll(member as object, `${prefix}${name}.`)
        }
      }
    }

    for (const name of ['live', 'listing', 'ready', 'delete'] as const) {
      expected.push(name)
      await client[name]()
    }
    for (const group of ACTOR_GROUPS) await callAll(client[group], `${group}.`)
    await client.dispose()

    expect(paths).toEqual(expected)
    expect(expected).toContain('inputs.reviews.withdraw')
    expect(expected.length).toBeGreaterThan(150)
    expect(paths).not.toContain('dispose')
  })

  it('the object refuses a path that is not an op on an actor group', async () => {
    const actor = { sessions: { summary: async () => 'summary' } } as unknown as AgentActor

    await expect(runActorOp(actor, 'sessions.summary', [])).resolves.toEqual({ value: 'summary' })
    for (const path of ['sessions.constructor', '__proto__.x', 'slug', 'dispose', 'sessions', 'sessions.summary.call']) {
      await expect(runActorOp(actor, path, []), path).resolves.toMatchObject({ error: expect.anything() })
    }
  })
})

describe("container.fetch keeps its caller's timeout, which no signal carries across", () => {
  /** An object that never answers: a render that hangs in the container. */
  const hanging: ActorObject = { actorCall: () => new Promise(() => {}) }

  it("stops waiting when the caller's signal fires, though the object has not answered", async () => {
    const client = new CloudflareAgentActor('sales-agent', reaching(hanging))
    const controller = new AbortController()

    const response = client.container.fetch('/render', { method: 'POST', body: 'graph TD', signal: controller.signal })
    controller.abort(new Error('The render took too long'))

    await expect(response).rejects.toThrow('The render took too long')
  })

  it('does not call the object for a signal that has already fired', async () => {
    const actorCall = vi.fn(() => new Promise<never>(() => {}))
    const client = new CloudflareAgentActor('sales-agent', reaching({ actorCall }))

    await expect(client.container.fetch('/render', { signal: AbortSignal.abort(new Error('Too late')) })).rejects.toThrow('Too late')
    expect(actorCall).not.toHaveBeenCalled()
  })

  it('discards a response that arrives after the caller stopped waiting', async () => {
    const cancel = vi.fn()
    let answer!: (outcome: { value: Response }) => void
    const client = new CloudflareAgentActor('sales-agent', reaching({ actorCall: () => new Promise((resolve) => { answer = resolve }) }))
    const controller = new AbortController()

    const response = client.container.fetch('/render', { signal: controller.signal })
    // The call is on its way to the object before the signal fires.
    await vi.waitFor(() => expect(answer).toBeDefined())
    controller.abort(new Error('The render took too long'))
    await expect(response).rejects.toThrow('The render took too long')
    answer({ value: new Response(new ReadableStream({ cancel })) })

    await vi.waitFor(() => expect(cancel).toHaveBeenCalled())
  })

  it('answers as before when the signal never fires', async () => {
    const fetch = vi.fn(async (path: string) => new Response(`rendered ${path}`))
    const { client } = overRpc({ container: { fetch } })

    const response = await client.container.fetch('/render', { signal: new AbortController().signal })

    expect(await response.text()).toBe('rendered /render')
  })
})

describe("the actor inside the agent's own object", () => {
  const object = {} as AgentDurableObject

  it("uses what the object holds only inside the agent's own object, and calls the object everywhere else", async () => {
    const remote = { slug: 'sales-agent', files: { getDoc: async () => 'remote' } } as unknown as AgentActor
    const agentObject: ActorObject = { actorCall: async (path, args) => runActorOp(remote, path, args) }
    const dispose = vi.fn(async () => {})
    const local = { slug: 'sales-agent', files: { getDoc: async () => 'local' }, dispose } as unknown as CloudflareAgentActorDO
    // The agent's object runs the agent in this isolate.
    objectActor('sales-agent', object, () => local)
    const reached = new CloudflareAgentActor('sales-agent', reaching(agentObject))

    expect(await reached.files.getDoc('AGENTS.md')).toBe('remote')
    expect(await runAsAgentObject('sales-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('local')
    expect(await runAsAgentObject('support-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('remote')

    // Dropped by the registry, it lets go of nothing: the agent's own actor is its object's to keep.
    await reached.dispose('shutdown')
    expect(dispose).not.toHaveBeenCalled()
    expect(await runAsAgentObject('sales-agent', object, () => reached.files.getDoc('AGENTS.md'))).toBe('local')
    expect(await reached.files.getDoc('AGENTS.md')).toBe('remote')

    // Only the object lets its actor go, when its agent is deleted.
    await evictObjectActor('sales-agent')
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("a new instance of the object gets ops of its own, and what the old one held is released", async () => {
    const dispose = vi.fn(async () => {})
    const first = { slug: 'sales-agent', dispose } as unknown as CloudflareAgentActorDO
    const second = { slug: 'sales-agent', dispose: vi.fn(async () => {}) } as unknown as CloudflareAgentActorDO
    const replaced = {} as AgentDurableObject

    expect(objectActor('sales-agent', object, () => first)).toBe(first)
    // The same instance keeps what it holds.
    expect(objectActor('sales-agent', object, () => second)).toBe(first)
    expect(objectActor('sales-agent', replaced, () => second)).toBe(second)
    expect(dispose).toHaveBeenCalledOnce()
    await evictObjectActor('sales-agent')
  })

  it("is ready when the agent's object says its actor is, and never sends dispose across", async () => {
    const ready = vi.fn(async () => {})
    const calls: string[] = []
    const agentObject: ActorObject = {
      actorCall: async (path, args) => {
        calls.push(path)
        return runActorOp({ slug: 'sales-agent', ready } as unknown as AgentActor, path, args)
      },
    }
    const reached = new CloudflareAgentActor('sales-agent', reaching(agentObject))

    await reached.ready()
    await reached.dispose()

    expect(ready).toHaveBeenCalledOnce()
    expect(calls).toEqual(['ready'])
  })

  it("keeps the agent's object for work its request starts later", async () => {
    const later = runAsAgentObject('sales-agent', object, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return servingAgentObject('sales-agent')
    })
    expect(await later).toBe(object)
    expect(servingAgentObject('sales-agent')).toBeNull()
  })
})
