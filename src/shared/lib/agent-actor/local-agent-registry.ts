/**
 * The actor desktop and the Node server run, where every agent's container
 * and files are managed by the process itself. Their entry points spell it out:
 *
 *   initializeAgentRegistry((slug) => new LocalAgentActor(slug, { containers: containerHost, host: localHostPort }))
 *
 * This is the same actor for the two places that have no entry point of their
 * own: tests, and the dev server. Both re-evaluate the backend modules while
 * the process runs (a test with `vi.resetModules`, the dev server on an edit),
 * so the actors here keep their state where a later evaluation finds it.
 */
import { containerHost } from '@shared/lib/container/container-host'
import { localHostPort } from '@shared/lib/host/local-host-port'
import type { AgentState } from './agent-state'
import { LocalAgentActor } from './base-agent-actor'
import { _defaultAgentActorForTest } from './registry'
import type { AgentSlug } from './types'

// On globalThis outside production, with the container host: a reload that
// lost the agents' state would strand every parked approval and live session.
const globalForAgentStates = globalThis as unknown as {
  agentActorStates: Map<AgentSlug, AgentState> | undefined
}

/** The state of each agent's actor, which outlives a re-evaluation of the backend modules. */
export const agentStatesSurvivingReloads: Map<AgentSlug, AgentState> =
  globalForAgentStates.agentActorStates ?? new Map<AgentSlug, AgentState>()
if (process.env.NODE_ENV !== 'production') {
  globalForAgentStates.agentActorStates = agentStatesSurvivingReloads
}

export function createLocalAgentActor(slug: AgentSlug): LocalAgentActor {
  return new LocalAgentActor(slug, { containers: containerHost, host: localHostPort }, agentStatesSurvivingReloads)
}

// A test that installs no registry gets these actors.
if (process.env.VITEST) _defaultAgentActorForTest(createLocalAgentActor)
