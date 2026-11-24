/**
 * The actor each agent's Durable Object holds, in this isolate.
 *
 * On Cloudflare an agent runs in its own object (cloudflare-agent.ts), which holds the agent's
 * actor (`CloudflareAgentActorDO`, made in boot.ts). Cloudflare can run several agents' objects in
 * one isolate, and can replace an object's instance while the isolate lives on, so the isolate
 * keeps which instance holds which actor: a new instance of an object gets a new one, and what
 * its predecessor held is released.
 *
 * Only types are imported here. The actor pulls in the whole app, and this module loads when the
 * Worker starts.
 */
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import type { AgentDurableObject } from './cloudflare-agent'
import type { CloudflareAgentActorDO } from './cloudflare-agent-actor-do'

const held = new Map<AgentSlug, { object: AgentDurableObject; actor: CloudflareAgentActorDO }>()

function release(slug: AgentSlug, actor: CloudflareAgentActorDO, reason?: 'shutdown'): Promise<void> {
  return actor.dispose(reason).catch((error: unknown) => {
    console.warn(`[AgentDurableObject ${slug}] Could not release what the agent held:`, error)
  })
}

/**
 * The agent's actor for its own object: made on the object's first call here, and made again for
 * a new instance of the object, whose storage and alarm the old one no longer reaches.
 */
export function objectActor(slug: AgentSlug, object: AgentDurableObject, make: () => CloudflareAgentActorDO): CloudflareAgentActorDO {
  const current = held.get(slug)
  if (current?.object === object) return current.actor
  if (current) void release(slug, current.actor)
  const actor = make()
  held.set(slug, { object, actor })
  return actor
}

/** The agent's actor if its object runs the agent in this isolate. */
export function heldObjectActor(slug: AgentSlug): CloudflareAgentActorDO | undefined {
  return held.get(slug)?.actor
}

/** Releases what the agent's object holds in this isolate, if it runs the agent here. */
export async function evictObjectActor(slug: AgentSlug, reason?: 'shutdown'): Promise<void> {
  const current = held.get(slug)
  if (!current) return
  held.delete(slug)
  await release(slug, current.actor, reason)
}

/** Releases every agent this isolate runs, storing the session activity each one recorded, as a shutdown does. */
export async function evictObjectActors(): Promise<void> {
  const released = [...held.entries()]
  held.clear()
  // Every one lets go before the first await.
  await Promise.all(released.map(([slug, { actor }]) => release(slug, actor, 'shutdown')))
}
