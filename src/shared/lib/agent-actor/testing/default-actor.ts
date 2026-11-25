/**
 * The actor a test gets when it installs no registry.
 *
 * Tests have no entry point to say which actor the process runs. The module
 * that makes desktop's actors names them here when a test loads it
 * (local-agent-registry.ts), and the registry asks here when it is used with
 * none installed.
 *
 * A module of its own, which neither of the two owns: a test that replaces
 * the registry module with only what it uses, or never loads the local actor,
 * leaves the other working. It is re-evaluated with them by
 * `vi.resetModules()`, so a default never outlives the modules it was made from.
 */
import type { AgentActor, AgentSlug } from '../types'

let createDefault: ((slug: AgentSlug) => AgentActor) | null = null

export function setDefaultActorForTests(createActor: (slug: AgentSlug) => AgentActor): void {
  createDefault = createActor
}

export function defaultActorForTests(): ((slug: AgentSlug) => AgentActor) | null {
  return createDefault
}
