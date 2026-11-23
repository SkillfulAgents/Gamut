import { useMemo, type CSSProperties } from 'react'
import { useQueries } from '@tanstack/react-query'
import { ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react'
import { MessageList } from '@renderer/components/messages/message-list'
import { WithoutSessionTray } from '@renderer/context/session-tray-context'
import { CalledAgentAvatar, calledSessionState, calledStateLabel, type CalledSessionState } from '@renderer/components/agents/called-agent-avatar'
import { AppLink } from '@renderer/components/ui/app-link'
import { useAgents, resolveRouteAgentId } from '@renderer/hooks/use-agents'
import { useInvocationList } from '@renderer/hooks/use-invocations'
import { sessionQuery } from '@renderer/hooks/query-options'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'

export interface AgentCallTab { slug: string; sessionId: string }

/**
 * The page reaches its transcript up under a floating header through
 * --header-overlap (globals.css); a transcript in the drawer has no header
 * above it, so it reaches nowhere.
 */
const NO_HEADER_OVERLAP = { '--header-overlap': '0px' } as CSSProperties

interface CalledSession {
  /** By the agent's id where it is known, so a call by either of its slugs is the one session. */
  call: AgentCallTab
  agent?: ApiAgent
  session?: ApiSession
  /** What this session last asked of it. */
  prompt: string
  state: CalledSessionState
  unavailable: boolean
}

/**
 * The sessions this one called through invoke_agent, most recent first, each
 * with the called agent and whether that session is working now. `viewing`
 * stays listed even before the transcript has saved the call that started it.
 */
function useCalledSessions(sessionId: string, agentSlug: string, viewing: AgentCallTab | null = null) {
  const history = useInvocationList(agentSlug, sessionId, true)
  const { isActive } = useMessageStream(sessionId, agentSlug, ['isActive'])
  const latest = useInvocationList(agentSlug, sessionId, false, isActive)
  const { data: agents } = useAgents()
  const calls = useMemo(() => {
    const byId = new Map<string, { slug: string; sessionId: string; prompt: string }>()
    for (const call of [...(history.data ?? []), ...(latest.data ?? [])].sort((a, b) => a.calledAt.localeCompare(b.calledAt))) {
      const slug = resolveRouteAgentId(call.agentSlug, agents) ?? call.agentSlug
      const key = JSON.stringify([slug, call.sessionId])
      byId.delete(key)
      byId.set(key, { slug, sessionId: call.sessionId, prompt: call.prompt })
    }
    if (viewing) {
      const slug = resolveRouteAgentId(viewing.slug, agents) ?? viewing.slug
      const key = JSON.stringify([slug, viewing.sessionId])
      if (!byId.has(key)) byId.set(key, { ...viewing, slug, prompt: '' })
    }
    return [...byId.values()].reverse()
  }, [history.data, latest.data, agents, viewing])
  const sessions = useQueries({ queries: calls.map(call => ({ ...sessionQuery(call.slug, call.sessionId), retry: false })) })
  const targetSlug = viewing && resolveRouteAgentId(viewing.slug, agents)
  return { history, targetSlug, calls: calls.map((call, index) => {
    const session = sessions[index]?.data as ApiSession | undefined
    return {
      call, agent: agents?.find(agent => agent.slug === call.slug), session, prompt: call.prompt,
      state: calledSessionState(session), unavailable: sessions[index]?.isError ?? false,
    }
  }) }
}

/**
 * The drawer's Invoked agents tab, the Subagents tab's pattern for other
 * agents: every session this one called, the working ones first, and picking
 * one shows that agent's conversation in place, read-only and live, with a way
 * back and a way to open the session itself.
 */
export function AgentSessionsTrayContent({ agentSlug, sessionId, target, openDetail }: {
  agentSlug: string; sessionId: string; target: AgentCallTab | null; openDetail: (call: AgentCallTab | null) => void
}) {
  const { history, targetSlug, calls: called } = useCalledSessions(sessionId, agentSlug, target)
  const viewed = target ? called.find(entry => entry.call.slug === targetSlug && entry.call.sessionId === target.sessionId) : undefined
  const active = called.filter(entry => entry.session && entry.state !== 'idle')
  const done = called.filter(entry => entry.session && entry.state === 'idle')
  const unknown = called.filter(entry => !entry.session)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="agent-sessions-tray">
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {viewed ? (
          <AgentSessionDetail key={viewed.call.sessionId} entry={viewed} onBack={() => openDetail(null)} />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto px-2 py-3" data-testid="agent-sessions-list">
            {called.length === 0 && (
              <div className="px-2 py-1 text-xs text-muted-foreground italic">{history.isPending ? 'Loading invoked sessions…' : history.isError ? 'Could not load invoked sessions.' : 'No agents invoked in this session yet.'}</div>
            )}
            <AgentSessionGroup title="Active" entries={active} onPick={openDetail} />
            <AgentSessionGroup title="Done" entries={done} onPick={openDetail} />
            <AgentSessionGroup title="Other sessions" entries={unknown} onPick={openDetail} />
          </div>
        )}
      </div>
    </div>
  )
}

function AgentSessionGroup({ title, entries, onPick }: { title: string; entries: CalledSession[]; onPick: (call: AgentCallTab) => void }) {
  if (entries.length === 0) return null
  return (
    <section className="mb-4 last:mb-0" data-testid={`agent-sessions-${title.toLowerCase()}`}>
      <h3 className="px-2 pb-1.5 text-xs font-normal text-muted-foreground">
        {title} · {entries.length}
      </h3>
      {entries.map(entry => (
        <AgentSessionRow key={JSON.stringify([entry.call.slug, entry.call.sessionId])} entry={entry} onPick={() => onPick(entry.call)} />
      ))}
    </section>
  )
}

/** Laid out as a Subagents row: who, then what it was asked; the chevron on hover says it drills in. */
function AgentSessionRow({ entry, onPick }: { entry: CalledSession; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      title={entry.prompt || undefined}
      data-testid="agent-sessions-list-row"
      data-working={entry.state !== 'idle' || undefined}
      className="group flex w-full items-start gap-2.5 rounded-item px-2 py-2 text-left transition-colors hover:bg-muted/60"
    >
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        <CalledAgentAvatar agent={entry.agent} state={entry.state} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]/5 text-foreground">{entry.agent?.name ?? entry.call.slug}</span>
        {entry.prompt && <span className="block truncate text-xs text-muted-foreground">{entry.prompt}</span>}
      </span>
      <ChevronRight
        aria-hidden
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  )
}

function AgentSessionDetail({ entry, onBack }: { entry: CalledSession; onBack: () => void }) {
  const status = !entry.session ? entry.unavailable ? 'Unavailable' : 'Loading…' : calledStateLabel[entry.state]
  return (
    <div className="flex flex-1 min-h-0 flex-col text-sm" style={NO_HEADER_OVERLAP} data-testid="agent-call-tray">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-4 pb-2">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 inline-flex shrink-0 rounded-icon p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="All invoked agents"
          title="All invoked agents"
          data-testid="agent-call-back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <CalledAgentAvatar agent={entry.agent} state={entry.state} size={16} />
        <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{entry.agent?.name ?? entry.call.slug}</h2>
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="agent-call-status">{status}</span>
        {entry.session && <AppLink
          to="/agents/$slug/sessions/$sessionId"
          params={{ slug: entry.call.slug, sessionId: entry.call.sessionId }}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-control px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="agent-call-open-session"
        >
          Open session
          <ArrowUpRight className="h-3 w-3" />
        </AppLink>}
      </div>
      <div className="flex flex-1 min-h-0 flex-col" data-testid="called-transcript">
        {entry.session ? (
          <WithoutSessionTray>
            <MessageList sessionId={entry.call.sessionId} agentSlug={entry.call.slug} readOnly />
          </WithoutSessionTray>
        ) : <p className="px-4 py-2 text-xs text-muted-foreground">{entry.unavailable ? 'This session is unavailable or you do not have access.' : 'Loading conversation…'}</p>}
      </div>
    </div>
  )
}
