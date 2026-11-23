import { useSessionSubagents } from '@renderer/hooks/use-session-subagents'

import { useIsVoiceModeActive } from '@renderer/lib/voice-mode-handoff'
import { useMessages, useStopBackgroundTask } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useElapsedTimer } from '@renderer/hooks/use-elapsed-timer'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePendingUserRequests } from '@shared/lib/tools/requests/use-pending-user-requests'
import { apiFetch } from '@renderer/lib/api'
import { labelBackgroundTasks } from '@renderer/lib/background-task-label'
import { resolveProviderError } from '@renderer/components/provider-error/provider-error-registry'
import { isProviderFacingError } from '@shared/lib/types/api'
import { isTurnStartingUserMessage } from './pending-message'
import { useCallback, useMemo, useState } from 'react'
import { useSettings } from '@renderer/hooks/use-settings'
import { agentAvatarAccent } from '@shared/lib/types/agent-avatar-orbs'
import { computerUsePreferences, type ComputerUseSettings } from '@shared/lib/computer-use/types'

import { deriveTaskList, Todo } from '@shared/lib/utils/derive-task-list'
import { ActivityCard, ActivityErrorCard, type ActivitySubagentItem } from './activity-card'
import { deriveActivityStatus } from './activity-orb'

interface AgentActivityIndicatorProps {
  sessionId: string
  agentSlug: string
}

export function AgentActivityIndicator({ sessionId, agentSlug }: AgentActivityIndicatorProps) {
  const {
    isActive, error, apiErrorCode, errorPresentation, activeStartTime, isCompacting,
    apiRetry, computerUseApp, computerUseAppIcon, backgroundTasks,
    isThinking,
  } = useMessageStream(sessionId, agentSlug, [
    'isActive', 'error', 'apiErrorCode', 'errorPresentation', 'activeStartTime', 'isCompacting',
    'apiRetry', 'computerUseApp', 'computerUseAppIcon', 'backgroundTasks', 'isThinking',
  ])
  const { data: pendingUserRequests } = usePendingUserRequests(agentSlug, sessionId)
  const { data: agent } = useAgent(agentSlug)
  // The agent's cursor colour, shown beside the app while cursors are on.
  const { data: settings } = useSettings()
  const cursorColor = computerUseApp && agent?.avatar
    && computerUsePreferences(settings?.computerUse as ComputerUseSettings | undefined).showCursor
    ? agentAvatarAccent(agent.avatar.color)
    : null

  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState(false)

  const stopBackgroundTask = useStopBackgroundTask()
  const handleStopTask = useCallback(
    async (taskId: string) => {
      await stopBackgroundTask.mutateAsync({ sessionId, agentSlug, taskId })
    },
    [stopBackgroundTask, sessionId, agentSlug]
  )

  const handleRevokeComputerUse = useCallback(async () => {
    setRevoking(true)
    setRevokeError(false)
    try {
      const res = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/computer-use/revoke`, { method: 'POST' })
      if (!res.ok) throw new Error()
    } catch {
      setRevokeError(true)
    } finally {
      setRevoking(false)
    }
  }, [agentSlug, sessionId])

  // The unified store's blocking predicate is the SAME one the server derives
  // the session's awaiting status from, so this indicator can no longer
  // disagree with the sidebar/header. It also covers the kinds the old
  // per-type list silently omitted: script_run, computer_use, and
  // capability_review used to read as "Working…" while a card was parked.
  const voiceModeActive = useIsVoiceModeActive(sessionId)
  const isAwaitingInput = isActive &&
    (pendingUserRequests ?? []).some((r) => r.blocking && !r.autoApproved)
  const { data: messages } = useMessages(sessionId, agentSlug)

  // Use activeStartTime from SSE (set when session_active fires) as primary source.
  // Falls back to last persisted user message timestamp (for page refresh recovery).
  // Queued (mid-turn) messages don't start a turn — skipping them keeps the
  // elapsed timer anchored to the turn-starting prompt after a refresh.
  const timerStartTime = useMemo(() => {
    if (activeStartTime) return new Date(activeStartTime)
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartingUserMessage(messages[i])) {
        return new Date(messages[i].createdAt)
      }
    }
    return null
  }, [activeStartTime, messages])

  const elapsed = useElapsedTimer(isActive ? timerStartTime : null)

  const { data: subagents } = useSessionSubagents(agentSlug, sessionId)
  const subagentRows: ActivitySubagentItem[] = (subagents?.entries ?? []).filter(entry => entry.activeSubagent || entry.waitingForChildren).map(entry => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    // Only the child command can be stopped once the SDK retires the parent task.
    taskId: entry.waitingForChildren ? null : entry.agentId,
    status: entry.status === 'running' ? 'running' : 'completed',
    progressSummary: entry.waitingForChildren || (entry.backgroundRunning && entry.isCompleted) ? 'background work still running' : entry.activeSubagent?.progressSummary ?? null,
  }))

  // Name each background task after the tool call that launched it (the
  // command, the subagent's description) so the rows say what would be stopped.
  const labeledBackgroundTasks = useMemo(
    () => labelBackgroundTasks(backgroundTasks, messages),
    [backgroundTasks, messages]
  )

  // Derive the todo/task list from TaskCreate/TaskUpdate (newer SDK) or fall back
  // to TodoWrite (older SDK). Memoized on [messages] so it doesn't re-scan the
  // whole transcript on every per-delta re-render driven by useMessageStream —
  // only when the persisted message list actually changes.
  const { todos, activeItem } = useMemo<{ todos: Todo[] | null; activeItem: Todo | null }>(
    () => deriveTaskList(messages),
    [messages]
  )


  // Show error if present
  if (error) {
    const isProviderError = isProviderFacingError(apiErrorCode, errorPresentation)
    const providerError = resolveProviderError(errorPresentation)
    // Routed to another placement (e.g. composer): ProviderErrorPlacement renders it there.
    if (isProviderError && providerError.placement !== 'inline') return null
    return (
      <div className="mx-auto mb-2 w-full max-w-[740px] px-4">
        {isProviderError ? (
          <providerError.Component message={error} presentation={errorPresentation ?? undefined} />
        ) : (
          <ActivityErrorCard message={error} />
        )}
      </div>
    )
  }

  // Don't render if not active
  if (!isActive) {
    return null
  }

  // One precedence order drives both the label and the orb's animation.
  const { statusText, orbState } = deriveActivityStatus({
    isAwaitingInput,
    isCompacting,
    apiRetry,
    isThinking,
    activeForm: activeItem?.activeForm ?? null,
  })

  return (
    <ActivityCard
      statusText={statusText}
      orbState={orbState}
      agent={agent}
      elapsed={elapsed}
      isAwaitingInput={isAwaitingInput}
      detached={voiceModeActive}
      computerUse={computerUseApp ? {
        app: computerUseApp,
        iconBase64: computerUseAppIcon,
        cursorColor,
        revoking,
        revokeError,
        onRevoke: handleRevokeComputerUse,
      } : null}
      subagents={subagentRows}
      backgroundTasks={labeledBackgroundTasks}
      todos={todos}
      onStopTask={handleStopTask}
    />
  )
}
