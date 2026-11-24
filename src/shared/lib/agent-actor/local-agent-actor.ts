/**
 * The actor of desktop and the Node server: an agent whose container and
 * files are managed by this process.
 */
import { background } from '@shared/lib/background'
import { processTimer } from '@shared/lib/container/process-timer'
import { BaseAgentActor, type AgentActorParts } from './base-agent-actor'
import { createLocalSessionStore } from './local-session-store'
import type { SessionStore } from './session-store'

/** What a local actor is given: this machine's container layer, and the host port. */
export type LocalActorParts = AgentActorParts

export class LocalAgentActor extends BaseAgentActor {
  /** A timer of this process: all an actor that lives and dies with its process needs. */
  private readonly idleWake = processTimer()

  /** The agent's workspace is its directory under the agents data directory. */
  protected createSessionStore(hooks: Pick<SessionStore, 'onActivity'>): SessionStore {
    return createLocalSessionStore(this.slug, {}, hooks)
  }

  protected wakeToCheckIdleAt(at: number): void {
    this.idleWake.set(at - Date.now(), () => background(this.checkIdle(), { name: 'agent-actor.check-idle' }))
  }

  protected cancelIdleWake(): void {
    this.idleWake.clear()
  }
}
