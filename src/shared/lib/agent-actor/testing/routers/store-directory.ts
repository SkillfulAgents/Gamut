/**
 * How a slug-keyed router reaches the stores the actors own. For tests: the
 * app calls no router.
 *
 * Per-agent in-memory state (open user-input requests, parked reviews and
 * re-auth waits, computer-use grants) is a field of the agent's actor, and
 * the app reaches it through the actor's ops. The routers (`reviewManager`
 * and friends) let a test read or drive that state by slug. They hold nothing
 * and nothing is attached to them: they find the agent's actor in the
 * registry and read its store.
 *
 * `get` makes the actor the way `agentRegistry.get` does, `peek` answers only
 * for an actor that exists, and `all` is the actors that exist now. Nothing
 * can be stored for an agent that has no actor, so a sweep over `all()` is
 * complete. Only an actor that runs in this process has stores here: one that
 * forwards to its agent elsewhere keeps them where the agent runs.
 */
import type { AgentState } from '../../agent-state'
import { agentRegistry, isAgentRegistryInitialized } from '../../registry'
import type { AgentActor, AgentSlug } from '../../types'

export interface AgentStoreDirectory<T> {
  /** The store of one agent, making its actor on first use. Never does I/O. */
  get(slug: AgentSlug): T
  /** The store if the agent has an actor; a read for an agent nothing has touched finds nothing. */
  peek(slug: AgentSlug): T | undefined
  /** Every store that exists now: one per actor. */
  all(): T[]
}

/** The in-memory state of an actor that runs in this process; none for one that does not. */
function stateOf(actor: AgentActor): AgentState | undefined {
  return (actor as { state?: AgentState }).state
}

/** One kind of store (`pick`), read from the registry's actors. */
export class AgentStores<T> implements AgentStoreDirectory<T> {
  private replaced: AgentStoreDirectory<T> | null = null

  constructor(
    private readonly what: string,
    private readonly pick: (state: AgentState) => T,
  ) {}

  /** Tests only: read the stores from `directory` in place of the registry's actors. Null goes back to them. */
  replaceWith(directory: AgentStoreDirectory<T> | null): void {
    this.replaced = directory
  }

  get(slug: AgentSlug): T {
    if (this.replaced) return this.replaced.get(slug)
    const state = stateOf(agentRegistry.get(slug))
    if (!state) throw new Error(`No ${this.what} for agent ${slug}: its actor does not run in this process`)
    return this.pick(state)
  }

  peek(slug: AgentSlug): T | undefined {
    if (this.replaced) return this.replaced.peek(slug)
    // Before any agent was used there is nothing to find.
    if (!isAgentRegistryInitialized()) return undefined
    const actor = agentRegistry.held().find((held) => held.slug === slug)
    const state = actor && stateOf(actor)
    return state ? this.pick(state) : undefined
  }

  all(): T[] {
    if (this.replaced) return this.replaced.all()
    if (!isAgentRegistryInitialized()) return []
    return agentRegistry.held().flatMap((actor) => {
      const state = stateOf(actor)
      return state ? [this.pick(state)] : []
    })
  }
}
