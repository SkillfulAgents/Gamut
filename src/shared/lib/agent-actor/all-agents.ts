/**
 * What the app asks of every agent at once: is anything running, which agents
 * a drive change reaches, stop them all. Each question goes through the
 * registry to the agents' actors, so nothing here knows how an agent runs its
 * container.
 *
 * "Every agent" is the actors this process holds (`agentRegistry.held()`).
 * Startup makes one for each agent (`wakeAgents`), so on desktop and the Node
 * server that is all of them.
 */
import { agentRegistry } from './registry'
import type { AgentActor, AgentSlug } from './types'

async function running(): Promise<AgentActor[]> {
  const actors = agentRegistry.held()
  const statuses = await Promise.all(actors.map((actor) => actor.container.status()))
  return actors.filter((_, i) => statuses[i].status === 'running')
}

/** Whether any agent's container runs, by what each actor last saw. */
export async function hasRunningAgents(): Promise<boolean> {
  return (await running()).length > 0
}

/** The agents whose containers run, by what each actor last saw. */
export async function runningAgentSlugs(): Promise<AgentSlug[]> {
  return (await running()).map((actor) => actor.slug)
}

/** Agents a drive change reaches only through a restart, and with `orStarting` every start not yet at its drive read too. */
export async function agentsHoldingDrives(options?: { orStarting?: boolean }): Promise<AgentSlug[]> {
  const actors = agentRegistry.held()
  const holding = await Promise.all(actors.map((actor) => actor.container.holdsDrives(options)))
  return actors.filter((_, i) => holding[i]).map((actor) => actor.slug)
}

/** Record every running agent as stale: it keeps what it started with until it restarts. */
export async function markRunningAgentsStale(): Promise<void> {
  await Promise.all((await running()).map((actor) => actor.container.invalidate()))
}

/**
 * Make every agent's actor once at startup, and wait for each to read its
 * container: actors are made on first use, so without this an agent nobody
 * opens would never see a container still running from before this launch.
 * From then on each actor watches its own.
 */
export async function wakeAgents(slugs: AgentSlug[]): Promise<void> {
  console.log(`[Agents] Initializing ${slugs.length} agents...`)
  await Promise.all(slugs.map((slug) => agentRegistry.get(slug).ready()))
  console.log(`[Agents] Initialized ${slugs.length} agents`)
}

// Must accommodate the full escalation chain of one stop: volume preparation
// (20s), then the stop/kill/force chain (25s).
const STOP_TIMEOUT_MS = 50000

/**
 * Give each agent one deadline to read its status and stop its container.
 * Only running containers need a stop, which avoids spawning CLI processes
 * for the rest.
 */
export async function stopAllAgents(): Promise<void> {
  await Promise.all(agentRegistry.held().map(async (actor) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Container stop timed out')), STOP_TIMEOUT_MS)
      })
      const { status } = await Promise.race([actor.container.status(), deadline])
      if (status === 'running') await Promise.race([actor.container.stop(), deadline])
    } catch (error) {
      console.error(`Failed to stop container for agent ${actor.slug}:`, error)
    } finally {
      clearTimeout(timer)
    }
  }))
}
