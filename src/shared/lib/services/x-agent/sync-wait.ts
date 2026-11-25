/**
 * The clocks a cross-agent call runs against: how long a sync call waits for
 * the target's turn, when a prompt may no longer be delivered, and the bounded
 * reads around them.
 */
import { agentRegistry } from '@shared/lib/agent-actor'
import { compactMessage } from '@shared/lib/services/x-agent-transcript-view'
import { DEADLINE, raceDeadline } from '@shared/lib/utils/race-deadline'

/**
 * After a sync invoke, the SDK may emit 'result' (which clears isActive) before
 * the assistant message has been flushed to the JSONL file. Poll briefly so
 * we return the actual response, not the user prompt.
 *
 * Total wait: ~5s (10 × 500ms). Generous enough to absorb slow filesystems
 * (NFS, encrypted home, AV scanners) without keeping the HTTP handler open
 * indefinitely. Polling stops as soon as an assistant entry is found.
 *
 * Returns the compacted last assistant message, or null if no assistant entry
 * appears within the retry window. compactMessage always returns non-empty
 * content for assistant entries (placeholders for thinking-only / empty turns),
 * so a null return here specifically means "no assistant turn was persisted".
 */
// Tests can shrink the retry budget via env to keep timeouts snappy.
const READ_RETRY_ATTEMPTS = Number(process.env.X_AGENT_READ_RETRY_ATTEMPTS) || 10
const READ_RETRY_INTERVAL_MS = Number(process.env.X_AGENT_READ_RETRY_INTERVAL_MS) || 500

// Sync x-agent calls hold the HTTP response open with zero bytes written until
// the target turn completes, and the container's fetch (undici) aborts any
// request whose response headers don't arrive within 300s ("fetch failed").
// Cap the sync wait well under that cliff: sync is meant for fast turns, so a
// slow turn promotes to the async contract (status 'running' + session id)
// instead of dying as a network error that invites the caller to retry.
//
// The budget is end-to-end from handler entry, not from when waitForIdle
// starts: policy review and container startup happen first and can be slow,
// and a wait that ignored them could still push the total response time past
// the transport cliff.
const SYNC_WAIT_TIMEOUT_DEFAULT_MS = 120_000

// Exported for unit tests. The env override can only SHORTEN the wait (its
// purpose is keeping tests snappy): the container tool docs promise "up to
// ~2 minutes", and a longer wait would both break that promise and erode the
// margin to the 300s transport cliff.
export function resolveSyncWaitTimeoutMs(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return SYNC_WAIT_TIMEOUT_DEFAULT_MS
  return Math.min(parsed, SYNC_WAIT_TIMEOUT_DEFAULT_MS)
}

const SYNC_WAIT_TIMEOUT_MS = resolveSyncWaitTimeoutMs(process.env.X_AGENT_SYNC_WAIT_TIMEOUT_MS)

/**
 * The sync wait a call runs with: the caller's own wait, clamped to
 * (0, the env-resolved maximum], or that maximum when it asks for none. A wait
 * that is not a positive number counts as none. A caller can only shorten the
 * wait, for the same transport-cliff reason the env override can.
 */
export function effectiveSyncWaitMs(requestedMs: number | undefined): number {
  return resolveSyncWait(requestedMs).ms
}

/** The wait a call runs with, and whether it is the caller's own (else the configured wait). */
export interface SyncWait {
  ms: number
  callerSupplied: boolean
}

/** {@link effectiveSyncWaitMs}, saying whether the caller's own wait applied. */
export function resolveSyncWait(requestedMs: number | undefined): SyncWait {
  if (requestedMs === undefined || Number.isNaN(requestedMs) || requestedMs <= 0) {
    return { ms: SYNC_WAIT_TIMEOUT_MS, callerSupplied: false }
  }
  return { ms: Math.min(requestedMs, SYNC_WAIT_TIMEOUT_MS), callerSupplied: true }
}

// Hard stop for delivering the prompt at all. Past this point the caller's
// fetch has been dead-or-dying for a while (undici gives up at 300s), so
// delivering anyway creates exactly the ghost run the caller's inevitable
// retry then duplicates. Applies to async invokes too — they also respond
// only after delivery, so a slow container start can strand them the same way.
// The 60s margin leaves room for the delivery call itself plus the response.
export const DELIVERY_CUTOFF_MS = 240_000

export function deliveryCutoffError(): string {
  return (
    `Target agent took too long to become ready (over ${Math.round(DELIVERY_CUTOFF_MS / 1000)}s), ` +
    'so the prompt was NOT delivered. It is safe to retry; prefer sync=false.'
  )
}

export function lateDeliveryRevokedError(): string {
  return (
    `Target agent took too long to start the session (over ${Math.round(DELIVERY_CUTOFF_MS / 1000)}s total). ` +
    'The invocation was cancelled and any late-created session is revoked, so nothing is running — ' +
    'it is safe to retry; prefer sync=false.'
  )
}

// Bounds the live sessions' stream attach — its WebSocket `ready` promise has no
// timeout of its own, so a wedged container would otherwise hold the caller's
// fetch open past its 300s header timeout.
export const SUBSCRIBE_TIMEOUT_MS = Number(process.env.X_AGENT_SUBSCRIBE_TIMEOUT_MS) || 30_000

export async function subscribeWithTimeout(subscribe: Promise<void>): Promise<void> {
  const result = await raceDeadline(subscribe, Date.now() + SUBSCRIBE_TIMEOUT_MS)
  if (result === DEADLINE) {
    // The stalled attach may still settle later; swallow its rejection so a
    // late failure doesn't become an unhandled rejection.
    subscribe.catch(() => {})
    throw new Error(`Timed out attaching to session stream after ${SUBSCRIBE_TIMEOUT_MS}ms`)
  }
}

/**
 * Wait for the target turn to finish within what's left of the caller's sync
 * budget (deadline is stamped at handler entry). Returns 'timeout' when the
 * budget is exhausted, before or during the wait.
 *
 * Every sync caller marks the session active before the prompt is delivered
 * (invoke) or checks isSessionActive just before waiting (get-transcript), so
 * an inactive session here means the turn already finished: the wait
 * resolving at once is correct, not a startup race.
 */
export async function waitForTurnWithinBudget(
  targetSlug: string,
  sessionId: string,
  deadline: number,
): Promise<'completed' | 'timeout'> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    // Pre-wait work can eat the whole budget; if the turn already finished
    // during it, that's a completion — reporting 'timeout' here would label a
    // finished turn 'running' and make the caller poll for a result it has.
    return (await agentRegistry.get(targetSlug).sessions.live(sessionId)).isActive ? 'timeout' : 'completed'
  }
  const outcome = await agentRegistry.get(targetSlug).sessions.waitForIdle(sessionId, { timeoutMs: remainingMs })
  return outcome === 'idle' ? 'completed' : 'timeout'
}

/**
 * The wait as the note states it. The configured wait (every agent call) keeps
 * the agent route's wording byte for byte: rounded whole seconds, even "0s"
 * for a test override below half a second. Only a wait the caller chose itself
 * is stated in ms below a second, so it never reads "0s".
 */
function formatWait({ ms, callerSupplied }: SyncWait): string {
  if (callerSupplied && ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  return `${Math.round(ms / 1000)}s`
}

export function syncWaitPromotedNote(wait: SyncWait): string {
  return (
    `Sync wait timed out after ${formatWait(wait)}, but the target agent is still ` +
    'working on this prompt. Do NOT re-invoke — that would start a duplicate run. ' +
    'Poll get_agent_session_transcript with this session_id to retrieve the result.'
  )
}

/**
 * `boundaryUuid` is the uuid of the last assistant entry persisted BEFORE the
 * current turn's prompt was delivered (undefined when the session is new or
 * had none). Seeing that entry still last means this turn's reply hasn't
 * flushed yet — keep polling rather than returning the previous turn's answer
 * as if it were this one's.
 */
export async function readLastAssistantMessage(
  targetSlug: string,
  sessionId: string,
  boundaryUuid?: string,
): Promise<{ role: string; content: string; toolName?: string } | null> {
  const reply = await readLastAssistantReply(targetSlug, sessionId, { boundaryUuid })
  if (!reply) return null
  return {
    role: reply.role,
    content: reply.content,
    ...(reply.toolName ? { toolName: reply.toolName } : {}),
  }
}

/** The last assistant entry, compacted, with what a caller may need beyond the text. */
export interface LastAssistantReply {
  uuid: string
  role: string
  /** The compact content: text, and placeholders for tool calls and thinking-only turns. */
  content: string
  /** The entry's own text only, never a placeholder; '' when it has none. */
  spoken: string
  toolName?: string
  isApiErrorMessage: boolean
}

export interface ReadLastAssistantOptions {
  /** See `readLastAssistantMessage`: the entry still last means the reply has not flushed. */
  boundaryUuid?: string
  /** How many reads; default `X_AGENT_READ_RETRY_ATTEMPTS` or 10. */
  attempts?: number
  /** The pause between reads; default `X_AGENT_READ_RETRY_INTERVAL_MS` or 500ms. */
  intervalMs?: number
  /** Count a system entry the tail read returns as the reply (the x-agent read does); default true. */
  includeSystem?: boolean
}

/**
 * The core of `readLastAssistantMessage`: the last assistant entry newer than
 * `boundaryUuid`, read from the tail up to `attempts` times while the reply
 * may still be flushing, or null when none appears.
 */
export async function readLastAssistantReply(
  targetSlug: string,
  sessionId: string,
  options: ReadLastAssistantOptions = {},
): Promise<LastAssistantReply | null> {
  const { boundaryUuid, attempts = READ_RETRY_ATTEMPTS, intervalMs = READ_RETRY_INTERVAL_MS, includeSystem = true } = options
  const actor = agentRegistry.get(targetSlug)
  for (let i = 0; i < attempts; i++) {
    // Only the most recent assistant entry matters, so read the transcript
    // from the tail instead of full-parsing it (transcripts reach 100MB+, and
    // this runs up to `attempts` times per invoke).
    const entry = await actor.messages.findLastEntry(sessionId, { kind: 'assistant' })
    const isStaleBoundary = boundaryUuid !== undefined && entry?.uuid === boundaryUuid
    if (entry && !isStaleBoundary && (includeSystem || entry.type !== 'system')) {
      const compact = compactMessage(entry)
      if (compact) {
        return {
          uuid: entry.uuid,
          role: compact.role,
          content: compact.content,
          spoken: compact.spoken,
          ...(compact.toolName ? { toolName: compact.toolName } : {}),
          isApiErrorMessage: entry.type !== 'system' && entry.isApiErrorMessage === true,
        }
      }
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  return null
}
