import { SessionChatColumn } from './session-chat-column'
import { pickRuntimeOptions } from '@shared/lib/container/runtime-options'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { WorkflowProvider } from '@renderer/context/workflow-context'
import { ContentCanvas } from './content-shell'
import { useCallback, useEffect, useMemo } from 'react'
import { useSession, useSetSessionMarkedUnread, useClearSessionUnread } from '@renderer/hooks/use-sessions'
import { HttpError } from '@renderer/lib/api'
import { SessionNotFound } from '@renderer/router/route-fallbacks'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { MessageTarget } from '@renderer/components/messages/locate-message'
import { useMarkSessionNotificationsRead } from '@renderer/hooks/use-notifications'
import { usePendingMessages, type PendingMessagesContextValue } from '@renderer/context/pending-messages-context'
import { useUser } from '@renderer/context/user-context'
import { useRenderTracker } from '@renderer/lib/perf'
import { computeContextPercent } from '@shared/lib/utils/context-usage'
import { useSessionSearch } from '@renderer/hooks/use-session-search'
import { SessionSearchBar } from '@renderer/components/messages/session-search-bar'

interface SessionViewProps {
  agentSlug: string
  sessionId: string | null
  onSessionCreated?: PendingMessagesContextValue['onSessionCreated']
}

/**
 * The session leaf, including `/sessions/new` with a null sessionId. Renders
 * the chat column and the per-session search bar. Where an automated session
 * came from (its schedule, trigger, caller) is a crumb in `AgentHeader`.
 *
 * `FilePreviewProvider` wraps this view. SessionRoute keeps it through first
 * send, and remounts it when navigating to a different session or fresh draft. The optimistic
 * `pendingMessagesRef` + two-holder `useMessageStream` live one level up in
 * `AgentShell`, so they survive leaving this leaf for a sibling sub-view and
 * coming back.
 */
export function SessionView({ agentSlug, sessionId, onSessionCreated: handleSessionCreated }: SessionViewProps) {
  useRenderTracker('SessionView')
  const navigate = useNavigate()
  const { data: session, error: sessionError } = useSession(sessionId, agentSlug)
  const markSessionNotificationsRead = useMarkSessionNotificationsRead()
  const setSessionMarkedUnread = useSetSessionMarkedUnread()
  const clearSessionUnread = useClearSessionUnread()
  const {
    onSessionCreated,
    getPendingMessages,
    onMessageSent,
    onMessageUuidAssigned,
    onPendingMessageAppeared,
    streamContextUsage,
  } = usePendingMessages()
  const { canUseAgent } = useUser()
  const isViewOnly = !canUseAgent(agentSlug)
  const search = useSessionSearch(!!sessionId, sessionId)

  // A mention's click target: the transcript lands on that message once, then the URL drops it.
  const routeSearch: { message?: unknown } = useSearch({ strict: false })
  const targetMessageId = typeof routeSearch.message === 'string' ? routeSearch.message : undefined
  const settleTarget = useCallback(() => {
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, message: undefined }), replace: true })
  }, [navigate])
  const messageTarget = useMemo<MessageTarget | undefined>(
    () => (targetMessageId ? { id: targetMessageId, onSettled: settleTarget } : undefined),
    [targetMessageId, settleTarget],
  )

  // Context usage: prefer live stream data, fall back to persisted session metadata
  const contextUsage = sessionId ? streamContextUsage ?? session?.lastUsage ?? null : null
  const contextPercent = contextUsage ? computeContextPercent(contextUsage) : null

  // Auto-mark notifications as read when viewing a session
  useEffect(() => {
    if (!sessionId) return
    const clearWrites = () => {
      markSessionNotificationsRead.mutate(sessionId)
      // "Mark as unread" survives until the session is *reopened*, so it clears
      // here and deliberately not in the visibilitychange handler below —
      // otherwise marking the session you're looking at would be undone by the
      // next window refocus.
      setSessionMarkedUnread.mutate({ sessionId, agentSlug, markedUnread: false })
    }
    // Take the dot down in the caches right away — waiting for the write plus
    // the session-list refetch is what made clicking a dotted session feel like
    // it lagged. A session that was actually dotted also writes immediately
    // rather than on the debounce below: the optimistic state has to match what
    // the server will report, or the next refetch puts the dot back.
    if (clearSessionUnread(agentSlug, sessionId)) {
      clearWrites()
      return
    }
    // Nothing was showing, so the writes are a no-op for the dot — keep them on
    // a small delay to avoid marking as read on quick navigation.
    const timeout = setTimeout(clearWrites, 1000)
    return () => clearTimeout(timeout)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Also mark notifications as read when the tab regains focus while viewing it
  useEffect(() => {
    if (!sessionId) return
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        markSessionNotificationsRead.mutate(sessionId)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // A genuine 404 (deep-link to a non-existent / deleted session) → ambiguous
  // not-found. The pending-messages guard means a just-created session
  // (optimistic ghost in flight while the backend catches up) never flashes
  // not-found — and the agent-level loader has already gated access.
  if (
    sessionId &&
    sessionError instanceof HttpError &&
    sessionError.status === 404 &&
    getPendingMessages(sessionId).length === 0
  ) {
    return <SessionNotFound agentSlug={agentSlug} />
  }

  return (
    <>
      <ContentCanvas />

      <FilePreviewProvider rememberTabs sessionAgentSlug={agentSlug} commentsEnabled={!isViewOnly}>
        <WorkflowProvider>
          <div className="flex-1 flex flex-col min-h-0">
            {sessionId && <SessionSearchBar search={search} />}
            <SessionChatColumn
              sessionId={sessionId}
              onSessionCreated={handleSessionCreated ?? onSessionCreated}
              agentSlug={agentSlug}
              agentId={session?.agentSlug}
              pendingUserMessages={getPendingMessages(sessionId)}
              isViewOnly={isViewOnly}
              contextPercent={contextPercent}
              runtimeOptions={session ? pickRuntimeOptions(session) : undefined}
              onPendingMessageAppeared={onPendingMessageAppeared}
              onMessageSent={onMessageSent}
              onMessageUuidAssigned={onMessageUuidAssigned}
              onMessageFailed={onPendingMessageAppeared}
              lastActivityAt={session?.lastActivityAt ? new Date(session.lastActivityAt) : null}
              contextUsage={contextUsage}
              pendingWakeAt={session?.pendingWakeAt}
              pendingWakeTaskId={session?.pendingWakeTaskId}
              pendingWakeNote={session?.pendingWakeNote}
              pendingWakeSummary={session?.pendingWakeSummary}
              messageTarget={messageTarget}
            />
          </div>
        </WorkflowProvider>
      </FilePreviewProvider>
    </>
  )
}

if (__RENDER_TRACKING__) {
  (SessionView as any).whyDidYouRender = true
}
