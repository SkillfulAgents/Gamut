import type { ApiToolCall } from '@shared/lib/types/api'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

export type SubagentStatus = 'running' | 'completed' | 'error' | 'cancelled' | 'unknown'

export interface SubagentRunInputs {
  toolCall: ApiToolCall
  agentId?: string | null
  status?: SubagentStatus
  isSessionActive?: boolean
  activeSubagent?: SubagentInfo | null
  isCompleted?: boolean
  backgroundRunning?: boolean
}

/** Where a subagent run stands, from its tool call and the live stream. */
export function subagentStatus({ toolCall, isSessionActive, activeSubagent, isCompleted, backgroundRunning }: SubagentRunInputs): SubagentStatus {
  if (backgroundRunning) return 'running'
  let status: SubagentStatus = 'cancelled'
  const isResumedRun = !!activeSubagent && activeSubagent.parentToolId !== toolCall.id
  if (
    isSessionActive &&
    activeSubagent &&
    !isCompleted &&
    (isResumedRun || toolCall.result === null || toolCall.result === undefined)
  ) {
    // activeSubagent may be a later SendMessage run for the same stable agent.
    // Its live lifecycle takes precedence over the original Agent tool result.
    status = 'running'
  } else if (toolCall.result !== null && toolCall.result !== undefined) {
    // Background agents return an immediate "async_launched" result — don't treat as completed
    // unless we've received a subagent_completed SSE event (isCompleted) for this tool
    if (toolCall.subagent?.status === 'async_launched' && isSessionActive && activeSubagent && !isCompleted) {
      status = 'running'
    } else {
      status = toolCall.isError ? 'error' : 'completed'
    }
  } else if (isCompleted) {
    // subagent_completed SSE received but tool_result not yet persisted/refetched
    status = 'completed'
  } else if (isSessionActive && (activeSubagent?.parentToolId === toolCall.id || !toolCall.subagent)) {
    status = 'running'
  }
  return status
}
