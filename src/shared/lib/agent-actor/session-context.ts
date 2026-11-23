import type { RuntimeContext, SavedContext, SessionContext } from '../container/context-breakdown-schema'
import type { SessionMetadata, SessionUsage } from '../types/agent'
import type { SessionStore } from './session-store'

export async function saveSettledContext(
  store: SessionStore, sessionId: string, usage: SessionUsage, snapshot: SavedContext | undefined, replayed: boolean,
): Promise<boolean> {
  let changed = false
  await store.index.update(sessionId, current => {
    changed = false
    const previous = current?.meta?.lastContext
    // Reconnecting clients may replay the final summary after a precise
    // measurement of that revision has been saved, or after a newer turn.
    if (snapshot && previous && (snapshot.revision === previous.revision ||
      (replayed && snapshot.measuredAt <= previous.measuredAt))) return null
    if (!snapshot && !previous && current?.meta?.lastUsage?.totalTokens === usage.totalTokens &&
      current.meta.lastUsage.contextWindow === usage.contextWindow) return null
    changed = true
    return { ...current?.meta, lastUsage: usage, lastContext: snapshot }
  })
  return changed
}

function lastRecorded(meta?: SessionMetadata | null): SessionContext {
  const saved = meta?.lastContext
  if (saved) return {
    breakdown: saved.breakdown,
    source: saved.kind === 'full' ? 'saved-full' : 'saved-estimate',
    capturedAt: saved.measuredAt,
  }
  const totalTokens = meta?.lastUsage?.totalTokens
  if (typeof totalTokens !== 'number') return { breakdown: null }
  // Older indexes can record the token count without the model's capacity.
  return { breakdown: null, source: 'saved-usage', usage: { totalTokens, contextWindow: meta?.lastUsage?.contextWindow ?? 0 } }
}

/** Read the persisted measurement first. Only a requested refresh or a session
 * with no record needs a live read, and the caller supplies only a running runtime. */
export async function readSessionContext(
  store: SessionStore, sessionId: string, refresh: boolean, measure: () => Promise<RuntimeContext>,
): Promise<SessionContext> {
  const metadata = async () => (await store.index.get(sessionId))?.meta
  const before = await metadata()
  const saved = lastRecorded(before)
  if (!refresh && saved.source) return saved

  let measurement: RuntimeContext
  try {
    measurement = await measure()
  } catch (error) {
    const fallback = lastRecorded(await metadata())
    if (!fallback.source) throw error
    return { ...fallback, refreshFailed: true }
  }
  const { breakdown, revision } = measurement
  if (!breakdown) return lastRecorded(await metadata())

  // An already saved revision changing while this request was in flight
  // means a later turn or compaction has a better answer. A revision that
  // simply is not saved yet is a valid live measurement (a turn in progress).
  let answer: SessionContext = { breakdown, source: 'live' }
  const measuredAt = new Date().toISOString()
  await store.index.update(sessionId, current => {
    const meta = current?.meta
    const savedRevision = meta?.lastContext?.revision
    if (revision && savedRevision === revision && meta) {
      answer = { breakdown, source: 'live' }
      return { ...meta, lastContext: { kind: 'full', revision, measuredAt, breakdown } }
    }
    const changed = savedRevision !== before?.lastContext?.revision ||
      meta?.lastUsage?.totalTokens !== before?.lastUsage?.totalTokens ||
      meta?.lastUsage?.contextWindow !== before?.lastUsage?.contextWindow
    answer = changed ? lastRecorded(meta) : { breakdown, source: 'live' }
    return null
  })
  return answer
}
