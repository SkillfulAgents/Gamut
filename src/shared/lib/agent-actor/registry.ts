import { containerHost } from '@shared/lib/container/container-host'
import { userInputRequestManager } from '@shared/lib/tools/requests/request-manager'
import { reviewManager } from '@shared/lib/proxy/review-manager'
import { accountReauthManager } from '@shared/lib/proxy/account-reauth-manager'
import { computerUsePermissionManager } from '@shared/lib/computer-use/permission-manager'
import { mcpReauthManager } from '@shared/lib/proxy/mcp-reauth-manager'
import * as sessionService from '@shared/lib/services/session-service'
import { appendAssistantEntry, appendInformationalEntry } from '@shared/lib/services/session-transcript-append'
import { recordSessionActivity } from '@shared/lib/services/session-activity'
import * as transcriptOps from './local-transcript-ops'
import { getAgentWorkspaceDir } from '@shared/lib/utils/file-storage'
import { syncAgentConnectionEnvironment } from '@shared/lib/container/connection-runtime-sync'
import { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import { localHostPort } from '@shared/lib/host/local-host-port'
import { LocalAgentActor, type LocalActorDeps } from './local-agent-actor'
import { serializingActor } from './serializing-actor'
import type { AgentState } from './agent-state'
import type { AgentStoreDirectory } from './store-directory'
import type { AgentActor, AgentRegistry, AgentSlug } from './types'

/**
 * Build a registry whose handles delegate to `deps`. A handle is created on
 * first `get` and holds the agent's in-memory state (see `AgentState`),
 * its container runtime among it. Evicting a handle releases it.
 *
 * The registry also hands the container host the way to the actors'
 * runtimes, and the user-input, review, re-auth and computer-use routers the
 * way to each actor's stores.
 */
export function createAgentRegistry(
  deps: LocalActorDeps,
  options: {
    /**
     * State the actors own that outlived an earlier registry: in development
     * the backend modules are re-evaluated on edit (the Vite adapter reloads
     * the SSR entry in the same process), and the host and the routers both
     * survive that on `globalThis`. What the actors hold — live sessions,
     * parked reviews and waits, open requests, grants — must survive with them, or a
     * reload strands every pending approval; so the singleton registry keeps
     * this map on `globalThis` too, and a reloaded module wraps each state in
     * a fresh handle: the new code over the state the old one built.
     */
    states?: Map<AgentSlug, AgentState>
  } = {},
): AgentRegistry {
  const states = options.states ?? new Map<AgentSlug, AgentState>()
  const handles = new Map<AgentSlug, LocalAgentActor>()

  const wrap = (slug: AgentSlug, state?: AgentState): LocalAgentActor => {
    const actor = new LocalAgentActor(slug, deps, state)
    handles.set(slug, actor)
    states.set(slug, actor.state)
    return actor
  }
  // Handles for whatever state the previous registry left: sweeps over
  // `all()` and reads through `peek` must see it without waiting for a `get`.
  for (const [slug, state] of states) wrap(slug, state)

  // A handle this registry does not hold wraps the agent's state if another
  // registry over the same map already made one. After a reload, a singleton
  // that survived on `globalThis` still calls the registry of its own module
  // evaluation; a fresh state there would replace the live one in the map.
  const get = (slug: AgentSlug): LocalAgentActor => handles.get(slug) ?? wrap(slug, states.get(slug))

  const evict = (slug: AgentSlug): void => {
    // Releasing the state drops the agent's runtime last: settling a parked
    // request may still want to recompute the agent's awaiting state.
    handles.get(slug)?.dispose()
    handles.delete(slug)
    states.delete(slug)
  }

  // What the host does across agents (stop all, is anything running, the
  // startup wake) it asks of the actors' runtimes. Wired here, by the
  // package that owns the actors, so no entry point has to remember to.
  deps.containerHost.attachAgentRuntimes({
    wake: (slug) => get(slug).firstRead,
    held: () => [...handles.values()].flatMap((actor) => actor.state.peekRuntime() ?? []),
    drop: (slug) => handles.get(slug)?.state.dropRuntime(),
  })

  // The routers over the actors' stores get the same: one directory each,
  // reading through the handles, so nothing is stored anywhere but on them.
  // A test double may not carry the port; the real routers do.
  const directory = <T>(pick: (state: AgentState) => T): AgentStoreDirectory<T> => ({
    get: (slug) => pick(get(slug).state),
    peek: (slug) => {
      const actor = handles.get(slug)
      return actor ? pick(actor.state) : undefined
    },
    all: () => [...handles.values()].map((actor) => pick(actor.state)),
  })
  deps.userInputRequestManager.attachAgents?.(directory((state) => state.inputRequests))
  deps.reviewManager.attachAgents?.(directory((state) => state.reviews))
  deps.accountReauthManager.attachAgents?.(directory((state) => state.accountReauth))
  deps.mcpReauthManager.attachAgents?.(directory((state) => state.mcpReauth))
  deps.computerUsePermissionManager.attachAgents?.(directory((state) => state.computerUse))

  return {
    get: (slug): AgentActor => get(slug),
    evict: async (slug) => evict(slug),
    evictAll: async () => {
      // Release every handle, its runtime with it. At shutdown the containers
      // are stopped first: see startup.ts.
      const released = [...handles.values()]
      for (const actor of released) actor.dispose()
      handles.clear()
      states.clear()
      // Activity an index recorded and has not stored yet is stored before
      // this settles: its wakeup does not come once dispatch has stopped,
      // and nothing reads the index again. After the release, which callers
      // rely on having happened by the time this returns its promise.
      await Promise.all(released.map((actor) =>
        actor.store.index.storeRecordedActivity().catch((error: unknown) => {
          console.warn(`[AgentRegistry] Could not store the recorded session activity of ${actor.slug}:`, error)
        }),
      ))
    },
  }
}

// The actors' state persists across dev-server hot reloads on globalThis,
// matching the host and the routers it is wired to: a reload
// that kept the routers but lost the state would leave every parked approval
// undecidable. See `createAgentRegistry`.
const globalForRegistry = globalThis as unknown as {
  agentActorStates: Map<AgentSlug, AgentState> | undefined
}
const agentActorStates = globalForRegistry.agentActorStates ?? new Map<AgentSlug, AgentState>()
if (process.env.NODE_ENV !== 'production') {
  globalForRegistry.agentActorStates = agentActorStates
}

/**
 * What a deployment whose agents run outside this process supplies, all at
 * once. Desktop and the Node server install nothing: each agent runs in this
 * process, with its files in a directory on this machine.
 */
export interface AgentDeployment {
  /** What `agentRegistry.get` hands out in place of the actor in this process, such as a client of the agent's actor in another process. */
  transport(slug: AgentSlug, local: AgentActor): AgentActor
  /** Where each agent's files, config documents and transcripts are (see `LocalActorDeps.createSessionStore`). */
  sessionStore: NonNullable<LocalActorDeps['createSessionStore']>
  /** The host the agents ask for host tools, machine work and side effects. */
  host: HostPort
  /** How a deleted agent's workspace is removed (see `setWorkspaceRemoval`). */
  removeWorkspace: WorkspaceRemoval
}

let deployment: AgentDeployment | undefined

/**
 * The one place a deployment sets how its agents run. Called once at boot,
 * before the first `get`: a handle already handed out keeps what it was made with.
 */
export function installAgentDeployment(installed: AgentDeployment): void {
  deployment = installed
  setWorkspaceRemoval(installed.removeWorkspace)
}

// Development and tests only: every actor reached through the serializing test transport.
const testTransport = process.env.NODE_ENV !== 'production' && process.env.SUPERAGENT_ACTOR_TRANSPORT === 'serializing'
  ? serializingActor
  : undefined

// Getters, not values: each dependency is read when an actor method runs, not
// when this module loads. A test that mocks one of these modules therefore
// intercepts exactly the call it always intercepted, and the others are never
// touched — the same as when the consumer imported the module directly.
const localActorDeps: LocalActorDeps = {
  get containerHost() {
    return containerHost
  },
  get userInputRequestManager() {
    return userInputRequestManager
  },
  get reviewManager() {
    return reviewManager
  },
  get accountReauthManager() {
    return accountReauthManager
  },
  get computerUsePermissionManager() {
    return computerUsePermissionManager
  },
  get mcpReauthManager() {
    return mcpReauthManager
  },
  get sessionService() {
    return sessionService
  },
  get transcripts() {
    return transcriptOps
  },
  get appendInformationalEntry() {
    return appendInformationalEntry
  },
  get appendAssistantEntry() {
    return appendAssistantEntry
  },
  get recordSessionActivity() {
    return recordSessionActivity
  },
  get getAgentWorkspaceDir() {
    return getAgentWorkspaceDir
  },
  get syncAgentConnectionEnvironment() {
    return syncAgentConnectionEnvironment
  },
  get loadDailyUsageData() {
    return loadDailyUsageData
  },
  get loadSessionUsageTotals() {
    return loadSessionUsageTotals
  },
  get host() {
    return deployment?.host ?? localHostPort
  },
}

/** The registry of desktop and the Node server: every agent's actor runs in this process. */
export function createLocalAgentRegistry(): AgentRegistry {
  return createAgentRegistry(localActorDeps, { states: agentActorStates })
}

// Installed by the entry point before anything uses an agent, like AppState
// and the database: desktop and the Node server install the local registry, a
// deployment whose actors run elsewhere its own. In this module, not on
// globalThis: a dev-server edit that re-evaluates it leaves the slot empty, and
// the dev server installs a registry of the new code.
//
// Tests only: the local registry, installed when this module loads, so a test
// needs no entry point. Under `npm run test:actor-transport` every actor is
// reached through the serializing test transport, as across a wire.
let installed: AgentRegistry | null = process.env.VITEST
  ? process.env.SUPERAGENT_ACTOR_TRANSPORT === 'serializing'
    ? serializingRegistry(createLocalAgentRegistry())
    : createLocalAgentRegistry()
  : null

function current(): AgentRegistry {
  if (!installed) {
    throw new Error('The agent registry is not initialized. The entry point must call initializeAgentRegistry() before anything uses an agent.')
  }
  return installed
}

/**
 * Installs the process's agent registry. A repeat call does nothing. It takes
 * the factory, not a registry: building one wires the host and the routers to it.
 */
export function initializeAgentRegistry(createRegistry: () => AgentRegistry): void {
  installed ??= createRegistry()
}

/** The registry's actors, each reached through one serializing transport. */
function serializingRegistry(registry: AgentRegistry): AgentRegistry {
  const reached = new WeakMap<AgentActor, AgentActor>()
  return {
    get: (slug) => {
      const actor = registry.get(slug)
      let outward = reached.get(actor)
      if (!outward) reached.set(actor, (outward = serializingActor(actor)))
      return outward
    },
    evict: (slug) => registry.evict(slug),
    evictAll: () => registry.evictAll(),
  }
}

/** The installed registry, read at each call. */
export const agentRegistry: AgentRegistry = {
  get: (slug) => current().get(slug),
  evict: (slug) => current().evict(slug),
  evictAll: () => current().evictAll(),
}
