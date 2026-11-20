import type { SendReceipt } from '@shared/lib/container/command-lifecycle'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'

/**
 * Optimistic local copy of a user message that has been POSTed to the server
 * but not yet observed in the persisted transcript.
 *
 * `localId` is a client-side correlation id: it is the stable render key and
 * the handle used to update/remove the entry. `uuid` is the server-assigned
 * message id (returned by the POST response); the server generates it (never
 * the client — it keys the messageAuthor attribution row) and forwards it to
 * the container where it becomes the JSONL entry id, so the optimistic copy
 * is materialized by exact id match once the message shows up in fetched
 * messages, a mid-turn (queued) one included.
 */
export interface PendingMessage {
  localId: string
  /** Server-assigned message uuid; set when the POST response arrives. */
  uuid?: string
  text: string
  sentAt: number
  /**
   * Sent while the agent was mid-turn. The message is buffered by the agent
   * loop (SDK streaming input) and rendered as a "queued" ghost until the
   * agent picks it up and it materializes in the transcript.
   */
  queued?: boolean
  sender?: { id: string; name: string; email: string; image?: string | null }
  /** A message list already took this ghost as a send; a later mount of the session's list does not again. */
  sendHandled?: boolean
}

/** True for user messages that start a new turn — queued (mid-turn) messages don't end the turn they appear in. */
export function isTurnStartingUserMessage(m: { type: string; queued?: boolean }): boolean {
  return m.type === 'user' && !m.queued
}

/** Ids a loaded transcript holds, merged sends included. */
export function savedSendIds(messages: readonly ApiMessageOrBoundary[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    ids.add(message.id)
    if (message.type === 'user') for (const uuid of message.mergedSendUuids ?? []) ids.add(uuid)
  }
  return ids
}

/**
 * Only evidence for a message's own uuid settles it. Never ran wins over a loaded copy:
 * a queued message is saved before a Stop can drop it. A message sent before this view
 * waits for the host's record, and a picked-up one clears once a load since the mount
 * misses it on a truncated page (its copy is above what is loaded).
 */
export function settlePending<T extends { uuid?: string; sentAt: number }>(input: {
  pending: readonly T[]
  /** null until the transcript has loaded. */
  saved: ReadonlySet<string> | null
  /** null until this connection's snapshot arrives. */
  receipts: Readonly<Record<string, SendReceipt>> | null
  mountedAt: number
  loadedSinceMount: boolean
  pageTruncated: boolean
}): { appeared: T[]; neverRan: T[] } {
  const appeared: T[] = []
  const neverRan: T[] = []
  for (const message of input.pending) {
    const { uuid } = message
    if (!uuid) continue
    const receipt = input.receipts?.[uuid]
    if (receipt === 'never_ran') neverRan.push(message)
    else if (!input.receipts && message.sentAt < input.mountedAt) continue
    else if (input.saved?.has(uuid)) appeared.push(message)
    else if (
      receipt === 'picked_up' &&
      input.saved &&
      message.sentAt < input.mountedAt &&
      input.loadedSinceMount &&
      input.pageTruncated
    ) appeared.push(message)
  }
  return { appeared, neverRan }
}
