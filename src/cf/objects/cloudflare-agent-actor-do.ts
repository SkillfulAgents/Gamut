/**
 * The agent's actor inside its own Durable Object (cloudflare-agent.ts): the base actor, kept
 * where the object keeps an agent. Its files are in its container or, asleep, in R2, with its
 * session index in the object's own storage; its idle check wakes on the object's alarm, which
 * outlives the isolate; and what it stored is purged by a task, which is tried again if it fails.
 *
 * The rest of the org reaches it as a `CloudflareAgentActor` (cloudflare-agent-actor.ts).
 *
 * Only boot.ts imports this module's value. It pulls in the whole app, which an object loads on
 * its first call, not when the Worker starts.
 */
import { BaseAgentActor, type AgentActorParts } from '@shared/lib/agent-actor/base-agent-actor'
import { createConfigOps } from '@shared/lib/agent-actor/config-ops'
import { SessionIndex } from '@shared/lib/agent-actor/session-index'
import { CLI_TRANSCRIPTS_DIR, type SessionStore } from '@shared/lib/agent-actor/session-store'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
import { taskManager } from '@shared/lib/background-work'
import { captureException } from '@shared/lib/error-reporting'
import { ingestSessionMetadataFile } from '@shared/lib/services/session-metadata-file'
import { sleepingStore, withAgentObject } from '../cloudflare-container-control'
import { createCloudflareFileOps } from '../cloudflare-file-ops'
import type { Env } from '../index'
import { createObjectSessionIndexStorage } from '../lib/object-session-index-storage'
import { PURGE_WORKSPACE_TASK } from '../lib/purge-workspace-task'
import type { AgentDurableObject } from './cloudflare-agent'

/** What the object's actor is given: what every actor is, and the object it is held in. */
export interface CloudflareAgentActorDOParts extends AgentActorParts {
  /** The agent's own object: its container, its storage and its alarm. */
  readonly object: AgentDurableObject
  readonly env: Env
}

export class CloudflareAgentActorDO extends BaseAgentActor {
  declare protected readonly parts: CloudflareAgentActorDOParts

  constructor(slug: AgentSlug, parts: CloudflareAgentActorDOParts) {
    super(slug, parts)
  }

  /** The agent's files are in its container, or in R2 while it sleeps; its session index is in the object's own storage. */
  protected createSessionStore(hooks: Pick<SessionStore, 'onActivity'>): SessionStore {
    const slug = this.slug
    const { env, object } = this.parts
    // Through the agent's object, which knows whether its container runs and answers asleep when it does not.
    const files = createCloudflareFileOps(async (path, init) => {
      // Asleep: the saved workspace answers, and no container request is built (its client reads the settings).
      if (!(await object.agentRunning())) return null
      // The container's API takes the agent's host token, as the container client sends it.
      const auth = await (await this.state.runtime().getClient()).getHostAuthHeaders()
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(auth)) headers.set(name, value)
      const streamed = init?.body instanceof ReadableStream
      return withAgentObject(env.AGENT, slug, env.VERSION?.timestamp, (agent) => agent.fetch(new Request(`http://container${path}`, { ...init, headers, ...(streamed ? { duplex: 'half' } : {}) } as RequestInit)))
    }, sleepingStore(env.AGENT, slug, env.VERSION?.timestamp))
    const key = `cloudflare:${slug}`
    const store: SessionStore = {
      slug,
      files,
      config: createConfigOps(files),
      transcriptsDir: CLI_TRANSCRIPTS_DIR,
      key,
      // As local-session-store.ts: a workspace's `session-metadata.json` is taken in before the index is first used.
      index: new SessionIndex({
        files,
        transcriptsDir: CLI_TRANSCRIPTS_DIR,
        key: () => key,
        // In the agent's own object, not the org's database: the actor runs only there, and a read costs no round trip.
        storage: createObjectSessionIndexStorage(() => object.sessionIndexSql()),
        beforeFirstUse: () => ingestSessionMetadataFile(store).catch((error: unknown) => {
          console.warn(`Could not take in the session metadata file of agent ${slug}:`, error)
          captureException(error, { tags: { component: 'session-store', operation: 'ingest-session-metadata' }, extra: { agent: slug }, level: 'warning' })
        }),
      }),
      onActivity: hooks.onActivity,
    }
    return store
  }

  /** The object's alarm, which runs the idle check itself when it goes off (`AgentDurableObject.alarm`). */
  protected wakeToCheckIdleAt(at: number): void {
    this.parts.object.scheduleIdleCheckBy(at)
  }

  protected cancelIdleWake(): void {
    this.parts.object.cancelIdleCheck().catch((error: unknown) => {
      console.error(`[AgentDurableObject ${this.slug}] cancelling the idle check failed:`, error)
    })
  }

  /**
   * The agent's saved files are in its object and R2, not in a directory. They are removed after
   * the answer, by a task that is tried again if it fails: the purge lists and deletes every
   * object the agent saved, and the agent is gone from the catalog by then, so nothing else would
   * try again. A removal that cannot be scheduled fails, and the agent is kept.
   */
  async delete(): Promise<void> {
    await taskManager().at(Date.now(), `${PURGE_WORKSPACE_TASK}:${this.slug}`, { taskType: PURGE_WORKSPACE_TASK, payload: { slug: this.slug } })
  }
}
