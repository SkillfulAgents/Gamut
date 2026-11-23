import { defineToolRenderer } from '../renderer-types'
import { SquareGanttChart, SquarePlus, SquareArrowRight, MessagesSquare, ArrowUpRight, ArrowDownToLine } from 'lucide-react'
import type { ToolRendererProps } from '../renderer-types'
import { ResultBlock } from '../ui/shared'
import { AppLink } from '@renderer/components/ui/app-link'
import { useSessionTray } from '@renderer/context/session-tray-context'
import { invokedSessionResult } from '@shared/lib/services/x-agent/invoked-session-schema'
import { ChevronDown, ChevronRight, PanelRight } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useAgents } from '@renderer/hooks/use-agents'
import { useInvocationList } from '@renderer/hooks/use-invocations'
import { sessionQuery } from '@renderer/hooks/query-options'
import { findCalledAgent } from '@renderer/components/tray/agent-calls'
import { CalledAgentAvatar, calledSessionState } from '@renderer/components/agents/called-agent-avatar'
import type { ToolHeaderProps } from '../renderer-types'
import type { ApiSession } from '@shared/lib/types/api'
import {
  listAgentsDef,
  createAgentDef,
  invokeAgentDef,
  getAgentSessionsDef,
  getAgentSessionTranscriptDef,
  downloadAgentFileDef,
} from './definition'

// ── shared helpers ────────────────────────────────────────────

function AgentLink({ slug, label }: { slug: string; label?: string }) {
  return (
    <AppLink
      to="/agents/$slug"
      params={{ slug }}
      className="inline-flex items-center gap-1 text-primary hover:underline"
    >
      {label ?? slug}
      <ArrowUpRight className="h-3 w-3" />
    </AppLink>
  )
}

function SessionLink({ slug, sessionId }: { slug: string; sessionId: string }) {
  return (
    <AppLink
      to="/agents/$slug/sessions/$sessionId"
      params={{ slug, sessionId }}
      className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
    >
      {sessionId.slice(0, 12)}…
      <ArrowUpRight className="h-3 w-3" />
    </AppLink>
  )
}

// ── list_agents ───────────────────────────────────────────────

function ListAgentsExpandedView({ result, isError }: ToolRendererProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Listing other agents in this workspace.</p>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const listAgentsRenderer = defineToolRenderer(listAgentsDef, {
  icon: SquareGanttChart,
  ExpandedView: ListAgentsExpandedView,
})

// ── create_agent ──────────────────────────────────────────────

function CreateAgentExpandedView({ input, result, isError }: ToolRendererProps) {
  const { name, description, instructions } = createAgentDef.parseInput(input)
  // Parse slug from result text if available (format: 'Created agent "X" with slug "Y".')
  const slugMatch = typeof result === 'string' ? result.match(/slug "([^"]+)"/) : null
  const createdSlug = slugMatch?.[1]

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        {name && <span className="font-medium">{name}</span>}
        {createdSlug && (
          <code className="rounded bg-background px-1.5 py-0.5 text-xs">{createdSlug}</code>
        )}
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {instructions && (
        <div>
          <div className="mb-1 text-xs font-medium tracking-wider text-muted-foreground">Instructions</div>
          <pre className="whitespace-pre-wrap rounded-item bg-background p-2 text-xs">{instructions}</pre>
        </div>
      )}
      {createdSlug && (
        <div className="text-xs">
          Open: <AgentLink slug={createdSlug} label={name ?? createdSlug} />
        </div>
      )}
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const createAgentRenderer = defineToolRenderer(createAgentDef, {
  icon: SquarePlus,
  ExpandedView: CreateAgentExpandedView,
})

// ── invoke_agent ──────────────────────────────────────────────

function InvokeAgentHeader({ input, result, isError, agentSlug, sessionId, toolUseId, isSessionActive, expanded, toggleDetails }: ToolHeaderProps) {
  const tray = useSessionTray()
  const { data: agents } = useAgents()
  const args = invokeAgentDef.parseInput(input)
  const returned = invokedSessionResult(result)
  const awaitingDelivery = !isError && !result && !args.session_id && !!isSessionActive
  const receipts = useInvocationList(agentSlug ?? '', sessionId ?? '', false, !!agentSlug && !!sessionId && awaitingDelivery)
  const receipt = awaitingDelivery ? receipts.data?.find(call => call.toolUseId === toolUseId) : undefined
  const requestedSlug = receipt?.agentSlug ?? args.slug ?? agentSlug
  const agent = requestedSlug ? findCalledAgent(requestedSlug, agents) : undefined
  const slug = agent?.slug ?? requestedSlug
  const childId = returned?.sessionId ?? args.session_id ?? receipt?.sessionId
  const child = useQuery({ ...sessionQuery(slug ?? '', childId ?? ''), enabled: !isError && !!slug && !!childId, retry: false })
  const state = calledSessionState(child.data as ApiSession | undefined, !isError && ((!result && !!isSessionActive) || returned?.status === 'running'))
  const name = agent?.name ?? slug ?? 'agent'
  const open = tray && slug && childId && !isError ? () => tray.openUtility('invoked-agents', { slug, sessionId: childId }) : undefined
  const detailsLabel = `${expanded ? 'Collapse' : 'Expand'} invoke agent tool details`

  return (
    <div className="flex items-stretch">
      <button type="button" onClick={open ?? toggleDetails} aria-label={open ? `Open ${name} session in tray` : detailsLabel}
        aria-expanded={open ? undefined : expanded} data-testid="invoke-agent-row"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/50">
        <CalledAgentAvatar agent={agent} state={state} size={16} />
        <span className="shrink-0 text-foreground/65">Invoke Agent</span>
        <span className="truncate text-xs text-muted-foreground">{name}{args.prompt ? ` · ${args.prompt}` : ''}</span>
        {isError && <span className="ml-auto text-xs text-destructive">Failed</span>}
      </button>
      {open ? <button type="button" onClick={toggleDetails} aria-label={detailsLabel} aria-expanded={expanded}
        data-testid="tool-call-toggle-mcp__agents__invoke_agent" className="shrink-0 px-2 text-muted-foreground hover:bg-muted/50">
        {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button> : null}
    </div>
  )
}

function InvokeAgentExpandedView({ input, result, isError, agentSlug }: ToolRendererProps) {
  const { slug, prompt, session_id, sync, attachments } = invokeAgentDef.parseInput(input)
  const target = slug ?? agentSlug
  // Parse sessionId + status from result (format: 'session_id: X\nstatus: Y\n...')
  const resolved = invokedSessionResult(result)
  const resolvedSessionId = resolved?.sessionId ?? session_id
  const tray = useSessionTray()

  return (
    <div className="space-y-3">
      {tray && target && resolvedSessionId && !isError && (
        <button
          type="button"
          onClick={() => tray.openUtility('invoked-agents', { slug: target, sessionId: resolvedSessionId })}
          className="inline-flex items-center gap-1.5 rounded-control border border-border/60 bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-muted"
          data-testid="invoke-agent-open-panel"
        >
          <PanelRight className="h-3.5 w-3.5 text-muted-foreground" />
          Open in panel
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Target:</span>
        {target ? <AgentLink slug={target} label={slug ? undefined : 'This agent'} /> : <span>—</span>}
        {resolvedSessionId && target && (
          <>
            <span className="text-muted-foreground">·</span>
            <SessionLink slug={target} sessionId={resolvedSessionId} />
          </>
        )}
        {sync && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            sync
          </span>
        )}
        {resolved && (
          <span
            className={`rounded px-1.5 py-0.5 text-xs ${
              resolved.status === 'completed'
                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                : 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
            }`}
          >
            {resolved.status}
          </span>
        )}
      </div>
      {prompt && (
        <div>
          <div className="mb-1 text-xs font-medium tracking-wider text-muted-foreground">Prompt</div>
          <div className="bg-background rounded-item p-2 text-xs whitespace-pre-wrap">
            {prompt}
          </div>
        </div>
      )}
      {!!attachments?.length && (
        <div>
          <div className="mb-1 text-xs font-medium tracking-wider text-muted-foreground">
            Attachments ({attachments.length})
          </div>
          <ul className="space-y-1 rounded-item bg-background p-2 text-xs">
            {attachments.map((path, index) => (
              <li key={`${path}-${index}`}>
                <code className="break-all">{path}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const invokeAgentRenderer = defineToolRenderer(invokeAgentDef, {
  Header: InvokeAgentHeader,
  icon: SquareArrowRight,
  ExpandedView: InvokeAgentExpandedView,
})

// ── get_agent_sessions ────────────────────────────────────────

function GetAgentSessionsExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug } = getAgentSessionsDef.parseInput(input)
  return (
    <div className="space-y-2">
      <div className="text-xs">
        <span className="text-muted-foreground">Sessions of:</span> {slug ? <AgentLink slug={slug} /> : '—'}
      </div>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const getAgentSessionsRenderer = defineToolRenderer(getAgentSessionsDef, {
  icon: SquareGanttChart,
  ExpandedView: GetAgentSessionsExpandedView,
})

// ── get_agent_session_transcript ──────────────────────────────

function GetAgentSessionTranscriptExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, session_id, sync } = getAgentSessionTranscriptDef.parseInput(input)
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Reading:</span>
        {slug ? <AgentLink slug={slug} /> : '—'}
        {slug && session_id && (
          <>
            <span className="text-muted-foreground">·</span>
            <SessionLink slug={slug} sessionId={session_id} />
          </>
        )}
        {sync && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800 dark:bg-amber-900 dark:text-amber-200">
            sync
          </span>
        )}
      </div>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const getAgentSessionTranscriptRenderer = defineToolRenderer(getAgentSessionTranscriptDef, {
  icon: MessagesSquare,
  ExpandedView: GetAgentSessionTranscriptExpandedView,
})

// ── download_agent_file ───────────────────────────────────────

function DownloadAgentFileExpandedView({ input, result, isError }: ToolRendererProps) {
  const { slug, session_id, delivery_id } = downloadAgentFileDef.parseInput(input)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Target:</span>
        {slug ? <AgentLink slug={slug} /> : <span>—</span>}
        <span className="text-muted-foreground">· Session:</span>
        {slug && session_id ? <SessionLink slug={slug} sessionId={session_id} /> : <span>—</span>}
        <span className="text-muted-foreground">· Delivery:</span>
        {delivery_id ? <code className="rounded bg-background px-1.5 py-0.5">{delivery_id}</code> : <span>—</span>}
      </div>
      <ResultBlock result={result} isError={isError} />
    </div>
  )
}

export const downloadAgentFileRenderer = defineToolRenderer(downloadAgentFileDef, {
  icon: ArrowDownToLine,
  ExpandedView: DownloadAgentFileExpandedView,
})
