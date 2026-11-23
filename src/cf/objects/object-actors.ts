/**
 * The agents' actors that run in this isolate. Each runs in its agent's own object
 * (cloudflare-agent.ts), and Cloudflare can run several agents' objects in one isolate, so the
 * isolate keeps one table of them. The container host and the user-input, review, re-auth and
 * computer-use routers of the isolate read the actors' state through it, as they read a local
 * registry's. Loaded with boot.ts, never when the Worker starts: the actor pulls in the whole app.
 */
import { LocalAgentActor, type LocalActorDeps, type SessionStoreHooks } from '@shared/lib/agent-actor/local-agent-actor'
import { attachLocalActors, localActorDeps } from '@shared/lib/agent-actor/registry'
import type { SessionStore } from '@shared/lib/agent-actor/session-store'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { AgentDurableObject } from './cloudflare-agent'

/** An agent's actor in its own object: the object's alarm is its idle wake-up, which outlives the isolate. */
export class CloudflareAgentActor extends LocalAgentActor {
  constructor(
    slug: AgentSlug,
    deps: LocalActorDeps,
    readonly object: AgentDurableObject,
    createSessionStore: (hooks: SessionStoreHooks) => SessionStore,
  ) {
    super(slug, deps, undefined, createSessionStore)
  }

  /** Reads now whether the container runs: the container outlives the object's memory, and its exits are not polled. */
  async syncContainerStatus(): Promise<void> {
    await this.state.runtime().syncAgentStatus()
  }

  protected override wakeToCheckIdleAt(at: number): void {
    this.object.scheduleIdleCheckBy(at)
  }

  protected override cancelIdleWake(): void {
    this.object.cancelIdleCheck().catch((error: unknown) => {
      console.error(`[CloudflareAgentActor ${this.slug}] cancelling the idle check failed:`, error)
    })
  }
}

const actors = new Map<AgentSlug, CloudflareAgentActor>()
let attached = false

/**
 * The agent's actor for its own object: made on the object's first call here, and made again
 * for a new instance of the object, whose storage and alarm the old actor no longer reaches.
 */
export function objectActor(slug: AgentSlug, object: AgentDurableObject, make: () => CloudflareAgentActor): CloudflareAgentActor {
  const held = actors.get(slug)
  if (held?.object === object) return held
  held?.dispose()
  if (!attached) {
    attached = true
    attachLocalActors(localActorDeps, {
      get: (agent) => {
        const actor = actors.get(agent)
        if (!actor) throw new Error(`The actor of agent ${agent} runs only in its own object, which has not run it in this isolate`)
        return actor
      },
      peek: (agent) => actors.get(agent),
      all: () => [...actors.values()],
    })
  }
  const actor = make()
  actors.set(slug, actor)
  return actor
}

/** The agent's actor if its object runs it in this isolate. */
export function heldObjectActor(slug: AgentSlug): CloudflareAgentActor | undefined {
  return actors.get(slug)
}

/** Releases the agent's actor in this isolate, if its object runs it here. */
export function evictObjectActor(slug: AgentSlug): void {
  actors.get(slug)?.dispose()
  actors.delete(slug)
}

/** Releases every actor in this isolate, storing the session activity each one recorded, as the local registry does. */
export async function evictObjectActors(): Promise<void> {
  const released = [...actors.values()]
  for (const actor of released) actor.dispose()
  actors.clear()
  await Promise.all(released.map((actor) =>
    actor.store.index.storeRecordedActivity().catch((error: unknown) => {
      console.warn(`[CloudflareAgentActor] Could not store the recorded session activity of ${actor.slug}:`, error)
    }),
  ))
}
