import { ChevronRight } from 'lucide-react'
import { SubagentTranscript, displaySubagentType } from '@renderer/components/messages/subagent-block'
import { useSessionSubagents, type SessionSubagent } from '@renderer/hooks/use-session-subagents'
import { useMessages } from '@renderer/hooks/use-messages'
import type { ApiToolCall } from '@shared/lib/types/api'
import { useMemo } from 'react'
import { SubagentAvatar } from '@renderer/components/agents/agent-avatar/subagent-avatar'
import { formatElapsed } from '@renderer/hooks/use-elapsed-timer'

interface SubagentsTrayContentProps {
  agentSlug: string
  sessionId: string
  target: string | null
  openDetail: (id: string | null) => void
}

/**
 * The drawer's Subagents tab. It opens on every subagent of the session, the
 * working ones first, and picking one shows its transcript in place with a way
 * back. One tab however many subagents there are, so they never crowd the strip.
 */
export function SubagentsTrayContent({ agentSlug, sessionId, target, openDetail }: SubagentsTrayContentProps) {
  const history = useSessionSubagents(agentSlug, sessionId)
  const entries = history.data?.entries ?? []
  const viewed = target ? history.data?.byId.get(target) : undefined
  const active = entries.filter(entry => entry.status === 'running')
  const done = entries.filter(entry => entry.status === 'completed' || entry.status === 'cancelled')
  const earlier = entries.filter(entry => entry.status === 'unknown')

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="subagents-tray">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {target ? (
          <SubagentDetail key={target} target={target} entry={viewed} sessionId={sessionId} agentSlug={agentSlug} openDetail={openDetail} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-2 py-3" data-testid="subagents-list">
            {history.isError && <p role="alert" className="p-2 text-xs">Could not load subagent history.</p>}
            {entries.length === 0 && !history.isError && (
              <div className="px-2 py-1 text-xs text-muted-foreground italic">{history.isPending ? 'Loading subagents…' : 'No subagents in this session yet.'}</div>
            )}
            <SubagentGroup title="Active" entries={active} onPick={openDetail} />
            <SubagentGroup title="Done" entries={done} onPick={openDetail} />
            <SubagentGroup title="Earlier" entries={earlier} onPick={openDetail} />
          </div>
        )}
      </div>
    </div>
  )
}

// The parent call can supply the prompt, result and token counts for this detail.
// It never determines membership or live status.
function SubagentDetail({ target, entry, agentSlug, sessionId, openDetail }: SubagentsTrayContentProps & {
  target: string; entry?: SessionSubagent
}) {
  const { data: messages } = useMessages(sessionId, agentSlug)
  const launch = useMemo(() => {
    for (const message of messages ?? []) {
      if (message.type !== 'assistant' && message.type !== 'user') continue
      const found = message.toolCalls?.find(call => (call.name === 'Agent' || call.name === 'Task')
        && (call.id === target || call.id === entry?.toolUseId || call.subagent?.agentId === (entry?.agentId ?? target)))
      if (found) return found
    }
  }, [messages, target, entry?.toolUseId, entry?.agentId])
  const toolCall: ApiToolCall | undefined = launch ?? (entry && {
    id: entry.toolUseId ?? entry.id, name: 'Agent',
    input: { subagent_type: entry.name, description: entry.description || entry.id },
  })
  if (!toolCall) return (
    <div className="p-4 text-sm text-muted-foreground">
      <button type="button" onClick={() => openDetail(null)}>All subagents</button>
      <p>Subagent details are unavailable.</p>
    </div>
  )
  return <SubagentTranscript {...entry} toolCall={toolCall} isSessionActive={entry?.status === 'running'}
    sessionId={sessionId} agentSlug={agentSlug} onBack={() => openDetail(null)} />
}

function SubagentGroup({ title, entries, onPick }: { title: string; entries: SessionSubagent[]; onPick: (id: string) => void }) {
  if (entries.length === 0) return null
  return (
    <section className="mb-4 last:mb-0" data-testid={`subagents-${title.toLowerCase()}`}>
      <h3 className="px-2 pb-1.5 text-xs font-normal text-muted-foreground">
        {title} · {entries.length}
      </h3>
      {entries.map(entry => (
        <SubagentListRow key={entry.id} entry={entry} onPick={() => onPick(entry.id)} />
      ))}
    </section>
  )
}

/** What the row says under the name: what a working agent is on, or how a finished one ended when it did not simply finish. */
function statusLine(entry: SessionSubagent): string | null {
  if (entry.status === 'running') {
    const tool = entry.activeSubagent?.lastToolName
    return tool ? `Working · ${tool}` : 'Working'
  }
  if (entry.status === 'cancelled') return 'Stopped'
  return null
}

function SubagentListRow({ entry, onPick }: { entry: SessionSubagent; onPick: () => void }) {
  const { activeSubagent, status } = entry
  const isRunning = status === 'running'
  const line = statusLine(entry)
  const duration = activeSubagent?.usage?.duration_ms
  return (
    <button
      type="button"
      onClick={onPick}
      data-testid="subagents-list-row"
      data-status={status}
      className="group flex w-full items-start gap-2.5 rounded-item px-2 py-2 text-left transition-colors hover:bg-muted/60"
    >
      <SubagentAvatar seed={entry.toolUseId ?? entry.id} size={16} state={isRunning ? 'working' : 'idle'} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]/5 text-foreground">{entry.description || (entry.name === 'Agent' ? entry.id : displaySubagentType(entry.name))}</span>
        {line && (
          <span className="block truncate text-xs text-muted-foreground">
            {line}
          </span>
        )}
      </span>
      {duration != null && duration > 0 && (
        <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{formatElapsed(duration)}</span>
      )}
      {/* Opens this subagent's transcript: shown on hover, like a list row that drills in. */}
      <ChevronRight
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  )
}
