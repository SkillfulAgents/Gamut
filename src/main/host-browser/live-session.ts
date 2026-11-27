/**
 * Which cloud session an agent's browser is, for every process that serves the
 * tenant. A provider's own map says only what its process launched: the
 * container's open and its close can reach different processes, and a process
 * that starts over forgets while the session runs on. The record is what they
 * share, so a launch finds the browser the agent has instead of opening a
 * second one, and a stop releases it wherever it was opened.
 *
 * One record per agent and provider, kept until a stop takes it. It has no
 * expiry: a session that ended by itself is found out when the record is next
 * used, and replaced.
 */
import { appState, defineNamespace, type Entry, type Revision } from '@shared/lib/app-state'
import { liveSessionSchema } from './live-session-schema'

export interface RecordedSession {
  readonly sessionId: string
  /** The write that recorded it: a replacement lands only while the record is still this one. */
  readonly revision: Revision
}

export interface LiveSessions {
  read(instanceId: string): Promise<RecordedSession | null>
  /**
   * Records `sessionId` as the instance's browser, only while the record is
   * still `replacing` (null: while there is none). Refused, it answers with
   * what another process recorded meanwhile.
   */
  record(instanceId: string, sessionId: string, replacing: RecordedSession | null): Promise<{ recorded: true } | { recorded: false; current: RecordedSession | null }>
  /**
   * Removes the record and returns its session, once: of competing stops, one
   * gets it. With `only`, the record is taken only while it names that
   * session, so a process letting go of what it opened leaves alone a browser
   * the agent got since.
   */
  take(instanceId: string, only?: string): Promise<string | null>
  /** Records again a session whose release did not get through, unless another was recorded since. */
  restore(instanceId: string, sessionId: string): Promise<void>
}

export function defineLiveSessions(provider: 'browserbase' | 'platform'): LiveSessions {
  const namespace = defineNamespace({
    name: `browser:${provider}:live-session`,
    consistency: 'strong',
    schema: liveSessionSchema,
    expiry: { ttlMs: null, onUpdate: 'keep' },
  })
  const recorded = (entry: Entry<{ sessionId: string }> | null): RecordedSession | null => (entry ? { sessionId: entry.value.sessionId, revision: entry.revision } : null)
  return {
    async read(instanceId) {
      return recorded(await appState().get(namespace.key(instanceId)))
    },
    async record(instanceId, sessionId, replacing) {
      const written = await appState().compareAndSet(namespace.key(instanceId), replacing?.revision ?? null, { sessionId })
      return written.ok ? { recorded: true } : { recorded: false, current: recorded(written.current) }
    },
    async take(instanceId, only) {
      const key = namespace.key(instanceId)
      if (only === undefined) {
        const taken = await appState().consume(key)
        return taken.consumed ? taken.entry.value.sessionId : null
      }
      const entry = await appState().get(key)
      if (entry?.value.sessionId !== only) return null
      return (await appState().consume(key, { revision: entry.revision })).consumed ? only : null
    },
    async restore(instanceId, sessionId) {
      await appState().insertIfAbsent(namespace.key(instanceId), { sessionId })
    },
  }
}

/** What became of a recorded session. `unknown`: it could not be read or reached, so it may still run. */
export type RecordedSessionState<C> = { state: 'running'; connection: C } | { state: 'ended' } | { state: 'unknown' }

/** A provider's sessions, as one launch uses them: its account is already in these. */
export interface SessionBrowser<C> {
  /** How to reach a recorded session, when it still runs. */
  connect(sessionId: string): Promise<RecordedSessionState<C>>
  create(): Promise<{ sessionId: string; connection: C }>
  /** Best effort: a release that fails is the provider's to report. */
  release(sessionId: string): Promise<unknown>
}

/** Launches racing for one agent: each round, one of them has recorded a session the others then use. */
const MAX_ROUNDS = 4

/**
 * The instance's browser: the recorded session while it runs, else a new one
 * recorded in its place. Of processes launching at once, one records its
 * session; the others release theirs and use that one, so the agent has one
 * browser and none is left running unrecorded.
 */
export async function openLiveSession<C>(sessions: LiveSessions, instanceId: string, browser: SessionBrowser<C>): Promise<{ sessionId: string; connection: C; reused: boolean }> {
  // A release that throws must not hide what the launch came to.
  const release = (sessionId: string) => Promise.resolve(browser.release(sessionId)).then(() => {}, () => {})
  let recorded = await sessions.read(instanceId)
  for (let round = 0; round < MAX_ROUNDS; round++) {
    let mayStillRun = false
    if (recorded) {
      const found = await browser.connect(recorded.sessionId)
      if (found.state === 'running') return { sessionId: recorded.sessionId, connection: found.connection, reused: true }
      mayStillRun = found.state === 'unknown'
    }

    const created = await browser.create()
    let written: Awaited<ReturnType<LiveSessions['record']>>
    try {
      written = await sessions.record(instanceId, created.sessionId, recorded)
    } catch (error) {
      // Unrecorded, no stop would ever find it.
      await release(created.sessionId)
      throw error
    }
    if (written.recorded) {
      // The session it replaces is no longer the agent's browser, and nothing else would release it.
      if (recorded && mayStillRun) await release(recorded.sessionId)
      return { sessionId: created.sessionId, connection: created.connection, reused: false }
    }
    // Another process recorded one meanwhile: that is the agent's browser.
    await release(created.sessionId)
    recorded = written.current
  }
  throw new Error(`The browser session of ${instanceId} kept changing while it was opened; try again`)
}
