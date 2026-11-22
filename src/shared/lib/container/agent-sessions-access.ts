import type { CoalescedUserMessage } from './runtime-death'
import type { ContainerClient } from './types'

/**
 * What a container runtime needs from its agent's live sessions. The sessions
 * live on the agent's actor; the runtime marks them when the container stops,
 * asks whether any is busy before putting it to sleep, and drives them through
 * recovery when it dies mid-turn.
 */
export interface RuntimeSessions {
  /** Mark the mid-turn sessions (only these, when given) recovering, and return them. */
  claimMidTurnForRecovery(restrictToSessionIds?: string[]): string[]
  /** Recovery gave up on these: they end their turn with an error. */
  settleRecovering(sessionIds: string[]): void
  /** Recovery resumed these: their turn carries on. */
  markRecovered(sessionIds: string[]): void
  /** The user messages sent while the session was recovering, taken for redelivery. */
  takeCoalesced(sessionId: string): CoalescedUserMessage[]
  isRecovering(sessionId: string): boolean
  isSubscribed(sessionId: string): boolean
  subscribe(sessionId: string, client: ContainerClient, containerSessionId: string): Promise<void>
  /** Run `work` in the session's delivery turn (see `LiveSessions.inDeliveryTurn`). */
  inDeliveryTurn<T>(sessionId: string, work: () => Promise<T>): Promise<T>
  /** The container is being stopped on purpose: every session mid-turn ends as stopped. */
  markAllStopped(): void
  /** The container is gone: no session is running. */
  markAllInactive(options?: { settleRecovering?: boolean }): void
  hasActive(): boolean
  hasAwaitingInput(): boolean
}
