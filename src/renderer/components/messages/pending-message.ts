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
 * messages. Mid-turn (queued) messages are re-id'd by the CLI on enqueue and
 * fall back to text+time matching.
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

/**
 * A ghost sent before this list mounted whose uuid the runtime reported taking,
 * while a page loaded since the mount stops short of the transcript's start:
 * its copy may be above that page, where no fetched message can match it.
 */
export function pickedUpAbovePage(
  pending: PendingMessage,
  view: { pickedUpSends: ReadonlySet<string>; mountedAt: number; hasOlder: boolean; dataUpdatedAt: number },
): boolean {
  return !!pending.uuid && view.pickedUpSends.has(pending.uuid) && pending.sentAt < view.mountedAt &&
    view.hasOlder && view.dataUpdatedAt >= view.mountedAt
}

/** True for user messages that start a new turn — queued (mid-turn) messages don't end the turn they appear in. */
export function isTurnStartingUserMessage(m: { type: string; queued?: boolean }): boolean {
  return m.type === 'user' && !m.queued
}
