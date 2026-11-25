import { createContext, useContext } from 'react'
import type { PendingMessage } from '@renderer/components/messages/pending-message'
import type { SessionUsage } from '@shared/lib/types/agent'

/**
 * Provided by AgentShell (the `/agents/$slug` layout route): the optimistic
 * pending-message store. AgentShell holds `pendingMessagesRef` so it survives
 * across the agent's sub-views; the agent body consumes it here instead of
 * owning it.
 *
 * The value stays one object while its callbacks and the store's content stay
 * the same: it changes when a pending message is added, updated or removed, not
 * on every AgentShell render. What changes more often than that (the stream's
 * context usage) has its own context below, so reading this one does not
 * subscribe a component to it.
 */
export interface PendingMessagesContextValue {
  getPendingMessages: (sessionId: string | null) => PendingMessage[]
  onMessageSent: (content: string, localId: string, queued: boolean) => void
  onMessageUuidAssigned: (localId: string, uuid: string, queued: boolean) => void
  onPendingMessageAppeared: (localId: string) => void
  /** `voiceMode` opens the new session's composer listening, with no ghost for the notice that started it. */
  onSessionCreated: (sessionId: string, initialMessage: string, messageUuid: string, options?: { voiceMode?: boolean; replace?: boolean }) => void
  clearPendingMessagesForSession: (sessionId: string) => void
}

const PendingMessagesContext = createContext<PendingMessagesContextValue | null>(null)

export const PendingMessagesProvider = PendingMessagesContext.Provider

export function usePendingMessages(): PendingMessagesContextValue {
  const ctx = useContext(PendingMessagesContext)
  if (!ctx) throw new Error('usePendingMessages must be used within an AgentShell')
  return ctx
}

/**
 * The live stream's context usage for the session in the URL; null when the
 * stream has reported none. AgentShell provides it from holder #1 of the
 * stream, so it survives across the agent's sub-views. It changes with every
 * `context_usage` event, several times a turn, so only what shows it reads it.
 */
const StreamContextUsageContext = createContext<SessionUsage | null>(null)

export const StreamContextUsageProvider = StreamContextUsageContext.Provider

export function useStreamContextUsage(): SessionUsage | null {
  return useContext(StreamContextUsageContext)
}
