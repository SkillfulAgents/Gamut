/**
 * The agents of this process: one actor per agent, made on first use.
 *
 * The registry knows nothing about how an actor works. The entry point says
 * which implementation the process uses, once, before anything touches an
 * agent, as it opens the database and installs AppState:
 *
 *   initializeAgentRegistry((slug) => new LocalAgentActor(slug, { containers, host }))
 *
 * Everything else reaches an agent through `agentRegistry.get(slug)` and the
 * `AgentActor` interface, and asks about the agents of the process through
 * `agentRegistry.held()`.
 *
 * This module imports no actor implementation: an implementation imports it.
 */
import { serializingActor } from './serializing-actor'
import { defaultActorForTests } from './testing/default-actor'
import type { AgentActor, AgentRegistry, AgentSlug } from './types'

/** Makes the actor of one agent. Never does I/O. */
export type CreateAgentActor = (slug: AgentSlug) => AgentActor

/** A registry over `createActor`: it makes each agent's actor once, and drops it on evict. */
export function createAgentRegistry(createActor: CreateAgentActor): AgentRegistry {
  const actors = new Map<AgentSlug, AgentActor>()
  return {
    get: (slug) => {
      let actor = actors.get(slug)
      if (!actor) {
        actor = createActor(slug)
        actors.set(slug, actor)
      }
      return actor
    },
    held: () => [...actors.values()],
    evict: async (slug) => {
      const actor = actors.get(slug)
      actors.delete(slug)
      await actor?.dispose()
    },
    evictAll: async () => {
      // Every actor lets go before this returns its promise: callers rely on
      // the release having happened by then. At shutdown the containers are
      // stopped first: see startup.ts.
      const released = [...actors.values()]
      actors.clear()
      await Promise.all(released.map((actor) => actor.dispose('shutdown')))
    },
  }
}

// Development and tests only: every actor is reached through the serializing
// test transport, as across a wire.
const throughTestTransport =
  process.env.NODE_ENV !== 'production' && process.env.SUPERAGENT_ACTOR_TRANSPORT === 'serializing'

// In this module, not on globalThis: a dev-server edit that re-evaluates it
// leaves the slot empty, and the dev server installs a registry of the new code.
let installed: AgentRegistry | null = null
/** What `installed` makes its actors with. */
let installedWith: CreateAgentActor | null = null

function install(createActor: CreateAgentActor): void {
  installed = createAgentRegistry(throughTestTransport ? (slug) => serializingActor(createActor(slug)) : createActor)
  installedWith = createActor
}

/**
 * Says how this process makes an agent's actor. Called once by the entry
 * point, before anything uses an agent; a repeat call does nothing.
 */
export function initializeAgentRegistry(createActor: CreateAgentActor): void {
  if (!installed) install(createActor)
}

/**
 * Whether a registry is installed. Given `createActor`, whether it is
 * installed over that very function: the dev server asks, since an edit can
 * re-evaluate the code that makes the actors and leave this module as it was.
 */
export function isAgentRegistryInitialized(createActor?: CreateAgentActor): boolean {
  return installed !== null && (createActor === undefined || installedWith === createActor)
}

/**
 * For a process whose backend modules are re-evaluated while it runs (the dev
 * server, on an edit): makes the agents' actors with `createActor` from here
 * on, in place of whatever was installed. The actors held so far are
 * forgotten, not disposed: what they held outlives them, and the actors made
 * next take it up (see local-agent-registry.ts).
 */
export function reinstallAgentRegistry(createActor: CreateAgentActor): void {
  install(createActor)
}

/**
 * Tests only: forget the installed registry, so the next use installs anew.
 * Given `createActor`, install a registry over it instead, as it is: a test
 * that makes its own actors reaches them directly, not through the test transport.
 */
export function _resetAgentRegistryForTest(createActor?: CreateAgentActor): void {
  installed = createActor ? createAgentRegistry(createActor) : null
  installedWith = createActor ?? null
}

function current(): AgentRegistry {
  if (!installed) {
    // Tests have no entry point: one that installs nothing gets the actors
    // desktop and the Node server run (see testing/default-actor.ts). Nothing
    // names a default outside tests.
    const forTests = defaultActorForTests()
    if (!forTests) {
      throw new Error('The agent registry is not initialized. The entry point must call initializeAgentRegistry() before anything uses an agent.')
    }
    // Made on first use, not when a module loads.
    initializeAgentRegistry(forTests)
  }
  return installed!
}

/** The process's agents, through whatever the entry point installed. */
export const agentRegistry: AgentRegistry = {
  get: (slug) => current().get(slug),
  held: () => current().held(),
  evict: (slug) => current().evict(slug),
  evictAll: () => current().evictAll(),
}
