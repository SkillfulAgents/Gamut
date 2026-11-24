
import { useRef, useMemo, useState } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { ArrowLeft, ChevronRight, Workflow } from 'lucide-react'
import { StreamingToolCallItem, StatusIndicator } from './tool-call-item'
import { flattenAssistantMessages, TranscriptItems, TranscriptText, type FlatItem } from './agent-transcript'
import { useSubagentMessages } from '@renderer/hooks/use-messages'
import { parseToolResult } from '@renderer/lib/parse-tool-result'
import type { ApiMessage } from '@shared/lib/types/api'
import { subagentStatus, type SubagentRunInputs } from './subagent-run'
import { useSessionSubagents } from '@renderer/hooks/use-session-subagents'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'
import { formatModelSlug } from '@renderer/lib/model-label'
import { modelSlugFromAgentType } from '@shared/lib/workflows/workflow-schemas'
import { SubagentAvatar } from '@renderer/components/agents/agent-avatar/subagent-avatar'
import { useSessionTray } from '@renderer/context/session-tray-context'

const SUBAGENT_LABEL_CLASS =
  'font-sans font-normal shrink-0 text-sm text-foreground/65 group-hover:text-foreground leading-none transition-colors'

interface SubAgentBlockProps extends SubagentRunInputs {
  sessionId: string
  agentSlug: string
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return `${tokens}`
}

export function displaySubagentType(subagentType: string): string {
  const slug = modelSlugFromAgentType(subagentType)
  return slug ? formatModelSlug(slug) : subagentType
}

/** How one subagent run stands: shared by its row in the chat and its tab in the drawer. */
export function useSubagentRun({
  toolCall,
  isSessionActive,
  activeSubagent,
  isCompleted,
  backgroundRunning,
  agentId,
  status: sharedStatus,
}: SubagentRunInputs) {
  // Determine subagent ID: prefer the SSE-discovered ID from the selected
  // original or resumed run over the API-based ID (from
  // resolveInterruptedSubagents, which re-sorts by mtime on every refetch and
  // can flip during active streaming).
  // Latch the ID once resolved — it should never revert to null.
  const sseAgentId = activeSubagent?.agentId ?? null
  const computedSubagentId = sseAgentId
    ?? agentId
    ?? toolCall.subagent?.agentId
    ?? null
  const latchedSubagentIdRef = useRef<string | null>(null)
  if (computedSubagentId) {
    latchedSubagentIdRef.current = computedSubagentId
  }
  const subagentId = computedSubagentId ?? latchedSubagentIdRef.current

  const status = sharedStatus ?? subagentStatus({ toolCall, isSessionActive, activeSubagent, isCompleted, backgroundRunning })

  // Extract display info — prefer live SSE data (available immediately from task_started),
  // fall back to tool_use input (available once the tool call is fully streamed)
  const input = toolCall.input as { subagent_type?: string; description?: string; prompt?: string }
  const subagentType = activeSubagent?.subagentType || input.subagent_type || 'Agent'
  const description = activeSubagent?.description || input.description || ''

  // Extract summary text — prefer persisted tool_result, fall back to SSE-delivered resultText.
  // A background launch's tool_result is its launch acknowledgement ("Async
  // agent launched successfully…"), not what the agent reported.
  const isLaunchAck = toolCall.subagent?.status === 'async_launched'
  const resultText = useMemo(() => {
    if (toolCall.subagent?.report !== undefined) return toolCall.subagent.report
    if (toolCall.result != null && !isLaunchAck) {
      const parsed = parseToolResult(toolCall.result)
      return parsed.text
    }
    if (activeSubagent?.resultText) {
      return activeSubagent.resultText
    }
    return null
  }, [toolCall.subagent?.report, toolCall.result, isLaunchAck, activeSubagent?.resultText])

  return {
    subagentId,
    status,
    isRunning: status === 'running',
    subagentDisplayType: displaySubagentType(subagentType),
    description,
    prompt: typeof input.prompt === 'string' ? input.prompt : '',
    resultText,
    // Stats from completed subagent
    stats: toolCall.subagent,
  }
}

/**
 * A subagent in the chat: one row that says what it is, what it is doing and
 * how it ended. Its transcript opens in the drawer's Subagents tab; the row
 * never expands in place.
 */
export function SubAgentBlock(input: SubAgentBlockProps) {
  const { data } = useSessionSubagents(input.agentSlug, input.sessionId)
  const run = data?.byId.get(input.toolCall.subagent?.agentId ?? '') ?? data?.byId.get(input.toolCall.id)
  const props = run ? { ...input, ...run, toolCall: input.toolCall } : input
  const { toolCall, activeSubagent } = props
  const tray = useSessionTray()
  const [expanded, setExpanded] = useState(false)
  const { status, isRunning, subagentDisplayType, description, resultText } = useSubagentRun(props)
  if (!tray && expanded) return <SubagentTranscript {...props} onBack={() => setExpanded(false)} />

  // What it is on while it runs; the first line of what it reported once it is done.
  const progress = isRunning
    ? [activeSubagent?.lastToolName, activeSubagent?.usage ? formatElapsed(activeSubagent.usage.duration_ms) : null].filter(Boolean).join(' · ')
    : resultText?.trim().split('\n')[0] ?? ''

  return (
    <button
      type="button"
      onClick={() => tray ? tray.openUtility('subagents', run?.id ?? toolCall.subagent?.agentId ?? toolCall.id) : setExpanded(true)}
      title="Open this sub-agent's transcript"
      data-testid="subagent-row"
      data-status={status}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-border/70 pl-2 pr-2 py-1.5 text-left text-sm group hover:bg-muted/50 transition-colors',
      )}
    >
      <Workflow aria-hidden className="h-3.5 w-3.5 shrink-0 text-foreground/45 group-hover:text-foreground transition-colors" />
      <span className={SUBAGENT_LABEL_CLASS}>Sub-agent:</span>
      <span className={SUBAGENT_LABEL_CLASS}>
        {subagentDisplayType}
      </span>
      {description && (
        <>
          <span aria-hidden className="shrink-0 text-foreground/40 group-hover:text-muted-foreground text-sm leading-none transition-colors">→</span>
          <span className="shrink-0 max-w-[45%] text-muted-foreground/70 group-hover:text-muted-foreground truncate text-xs leading-none transition-colors">
            {description}
          </span>
        </>
      )}
      {progress && (
        <span
          className={cn(
            'min-w-0 truncate text-xs leading-none',
            isRunning ? 'font-mono text-muted-foreground/60' : status === 'error' ? 'text-destructive/80' : 'text-muted-foreground/60',
          )}
          data-testid="subagent-row-progress"
        >
          {progress}
        </span>
      )}
      <span className="relative ml-auto flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="transition-opacity group-hover:opacity-0">
          {status !== 'unknown' && <StatusIndicator status={status} />}
        </span>
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/60 opacity-0 transition-opacity group-hover:text-muted-foreground group-hover:opacity-100">
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      </span>
    </button>
  )
}

/**
 * A subagent's whole transcript, live: its task, every text block and tool
 * call, what is streaming now, and the result it handed back. What the
 * Subagents tab shows once one subagent is picked from its list.
 */
export function SubagentTranscript(props: SubAgentBlockProps & {
  /** Back to the list of subagents. */
  onBack?: () => void
}) {
  const { toolCall, sessionId, agentSlug, isSessionActive, activeSubagent, onBack } = props
  const { subagentId, status, isRunning, subagentDisplayType, description, prompt, resultText, stats } = useSubagentRun(props)

  // Both entry points read the same transcript query, invalidated by the session stream.
  const { data: subMessages } = useSubagentMessages(sessionId, agentSlug, subagentId)
  const firstMessage = subMessages?.[0]
  const task = prompt || (firstMessage?.type === 'user' ? firstMessage.content.text : '')

  // The parent selects this block's original or resumed run. A SendMessage
  // run has a different tool id but still streams into the same transcript.
  const subagentStreamingMessage = activeSubagent?.streamingMessage ?? null
  const subagentStreamingToolUse = activeSubagent?.streamingToolUse ?? null

  // Check if streaming text is already persisted (same dedup pattern as main agent)
  const isStreamingMessagePersisted = useMemo(() => {
    if (!subagentStreamingMessage || !subMessages?.length) return false
    const assistantMessages = subMessages.filter(
      (m): m is ApiMessage => m.type === 'assistant'
    )
    if (assistantMessages.length === 0) return false
    const lastAssistant = assistantMessages[assistantMessages.length - 1]
    const persistedText = lastAssistant.content.text?.trim() || ''
    const streamingText = subagentStreamingMessage.trim()
    if (!persistedText || !streamingText) return false
    return persistedText.startsWith(streamingText) || streamingText.startsWith(persistedText)
  }, [subMessages, subagentStreamingMessage])

  // Check if streaming tool use is already persisted
  const isStreamingToolUsePersisted = useMemo(() => {
    if (!subagentStreamingToolUse || !subMessages?.length) return false
    return subMessages.some(m =>
      m.type === 'assistant' &&
      (m as ApiMessage).toolCalls?.some(tc => tc.id === subagentStreamingToolUse.id)
    )
  }, [subMessages, subagentStreamingToolUse])

  // Flatten assistant messages into individual renderable items (text blocks + tool calls)
  const flatItems = useMemo<FlatItem[]>(() => flattenAssistantMessages(subMessages), [subMessages])

  // Check if the result text is already present in the persisted flat items (dedup)
  const isResultInFlatItems = useMemo(() => {
    if (!resultText || !flatItems.length) return false
    const lastTextItem = [...flatItems].reverse().find(i => i.kind === 'text')
    if (!lastTextItem || lastTextItem.kind !== 'text') return false
    const persistedText = lastTextItem.text.trim()
    const result = resultText.trim()
    return persistedText.includes(result) || result.includes(persistedText)
  }, [resultText, flatItems])

  const totalItems = flatItems.length
  const hasStreamingContent = !!(subagentStreamingMessage && !isStreamingMessagePersisted)
    || !!(subagentStreamingToolUse && !isStreamingToolUsePersisted)

  return (
    <div className="flex min-h-0 flex-1 flex-col text-sm" data-testid="subagent-transcript" data-status={status}>
      {/* Who it is and how it stands */}
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 inline-flex shrink-0 rounded-icon p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="All subagents"
            title="All subagents"
            data-testid="subagent-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        {/* Behind a back arrow the tab already says what this is; the icon only names it where it stands alone. */}
        {!onBack && <SubagentAvatar seed={toolCall.id} size={20} state={isRunning ? 'working' : 'idle'} />}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {description || subagentDisplayType}
        </h2>
        <span className="shrink-0 rounded px-1 py-px text-[10px] leading-tight bg-muted text-muted-foreground/80">
          {subagentDisplayType}
        </span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {status !== 'unknown' && <StatusIndicator status={status} />}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
        {/* The task it was given, so the transcript reads on its own. */}
        {task && (
          <div className="mb-3 rounded-item bg-muted/50 px-3 py-2 text-xs" data-testid="subagent-task">
            <div className="mb-1 text-2xs text-muted-foreground/70">Task</div>
            <div className="whitespace-pre-wrap break-words text-foreground/80">{task}</div>
          </div>
        )}

        <div className="space-y-3">
          {totalItems === 0 && isRunning && !hasStreamingContent && (
            <div className="text-xs text-muted-foreground italic py-2">
              Sub-agent is working...
            </div>
          )}
          {totalItems === 0 && !isRunning && !subagentId && (
            <div className="text-xs text-muted-foreground italic py-2">
              No sub-agent messages available
            </div>
          )}

          <TranscriptItems items={flatItems} agentSlug={agentSlug} isSessionActive={isSessionActive} />

          {/* Streaming text from subagent (not yet persisted) */}
          {subagentStreamingMessage && !isStreamingMessagePersisted && (
            <TranscriptText mode="streaming" agentSlug={agentSlug}>{subagentStreamingMessage}</TranscriptText>
          )}

          {/* Streaming tool use from subagent (not yet persisted) */}
          {subagentStreamingToolUse && !isStreamingToolUsePersisted && (
            <StreamingToolCallItem
              name={subagentStreamingToolUse.name}
              partialInput={subagentStreamingToolUse.partialInput}
            />
          )}

          {/* Result summary from tool_result (available immediately, no JSONL refetch needed) */}
          {resultText && !isResultInFlatItems && !isRunning && (
            <TranscriptText mode="settled" agentSlug={agentSlug}>{resultText}</TranscriptText>
          )}
        </div>
      </div>

      {/* Stats footer — show live usage while running, final stats when completed */}
      {stats && status !== 'running' && (stats.totalTokens != null || stats.totalDurationMs != null || stats.totalToolUseCount != null) && (
        <div className="shrink-0 border-t border-border/40 px-4 py-2 text-xs text-muted-foreground" data-testid="subagent-stats">
          {stats.totalDurationMs != null && formatElapsed(stats.totalDurationMs)}
          {stats.totalTokens != null && (
            <>{stats.totalDurationMs != null && ' · '}{formatTokens(stats.totalTokens)} tokens</>
          )}
          {stats.totalToolUseCount != null && (
            <> · {stats.totalToolUseCount} tool call{stats.totalToolUseCount !== 1 ? 's' : ''}</>
          )}
        </div>
      )}
      {isRunning && activeSubagent?.usage && (
        <div className="shrink-0 border-t border-border/40 px-4 py-2 text-xs text-muted-foreground" data-testid="subagent-stats">
          {formatElapsed(activeSubagent.usage.duration_ms)}
          {' · '}{formatTokens(activeSubagent.usage.total_tokens)} tokens
          {' · '}{activeSubagent.usage.tool_uses} tool call{activeSubagent.usage.tool_uses !== 1 ? 's' : ''}
          {activeSubagent.lastToolName && (
            <> · <span className="font-mono">{activeSubagent.lastToolName}</span></>
          )}
        </div>
      )}
    </div>
  )
}
