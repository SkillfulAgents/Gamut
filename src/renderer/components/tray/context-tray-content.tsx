import { useState, type ReactNode } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ContextBreakdown } from '@shared/lib/container/context-breakdown-schema'
import { useContextBreakdown } from '@renderer/hooks/use-context-breakdown'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useSendMessage } from '@renderer/hooks/use-messages'
import { useSession } from '@renderer/hooks/use-sessions'
import { useUser } from '@renderer/context/user-context'

/** 512.4K, 33K, 1M: one decimal, none when it is .0. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(tokens)
}

function percentOf(tokens: number, window: number): string {
  return window > 0 ? `${((tokens / window) * 100).toFixed(1)}%` : '—'
}

/** A colour per row, by the CLI's stable id; an id the app does not know is drawn neutral. */
const SWATCH: Record<string, string> = {
  messages: 'bg-blue-500',
  mcp_tools: 'bg-orange-500',
  system_tools: 'bg-emerald-500',
  system_prompt: 'bg-amber-500',
  custom_agents: 'bg-violet-400',
  memory_files: 'bg-neutral-400',
  skills: 'bg-neutral-400',
  mcp_instructions: 'bg-neutral-400',
}
const BUFFER_SWATCH = 'bg-neutral-300 dark:bg-neutral-600'
const FREE_SWATCH = 'bg-muted'

type Category = ContextBreakdown['categories'][number]

function swatchOf(category: Category): string {
  if (category.kind === 'buffer') return BUFFER_SWATCH
  if (category.kind === 'free') return FREE_SWATCH
  if (category.kind === 'deferred') return 'bg-neutral-300/60 dark:bg-neutral-700'
  return (category.id && SWATCH[category.id]) || 'bg-neutral-400'
}

function Row({ category, window }: { category: Category; window: number }) {
  const deferred = category.kind === 'deferred'
  return (
    <li className="flex items-center gap-3 py-1 text-sm" data-testid="context-row" data-kind={category.kind}>
      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-[3px]', swatchOf(category))} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate', deferred ? 'text-muted-foreground' : 'text-foreground')}>{category.name}</span>
      <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{formatTokens(category.tokens)}</span>
      <span className="w-14 shrink-0 text-right tabular-nums text-foreground">{deferred ? '—' : percentOf(category.tokens, window)}</span>
    </li>
  )
}

/** A folded list behind one of the rows: its items and what each costs. */
function Details({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (count === 0) return null
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-1 text-left text-sm text-foreground"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="flex-1">{title}</span>
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </button>
      {open && <ul className="mb-1 ml-5 border-l border-border/60 pl-3">{children}</ul>}
    </li>
  )
}

function Item({ name, tokens }: { name: string; tokens: number }) {
  return (
    <li className="flex items-center gap-3 py-0.5 text-xs">
      <span className="min-w-0 flex-1 truncate text-muted-foreground" title={name}>{name}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatTokens(tokens)}</span>
    </li>
  )
}

/**
 * The drawer's Context tab: what fills the session's context window, as the
 * CLI's `/context` counts it. Read when the tab opens, when a measurement
 * is saved, and on Refresh.
 */
export function ContextTrayContent({ agentSlug, sessionId }: { agentSlug: string; sessionId: string }) {
  const { canUseAgent } = useUser()
  const canRead = canUseAgent(agentSlug)
  const query = useContextBreakdown(sessionId, agentSlug, canRead)
  const { data: session } = useSession(sessionId, agentSlug)
  const { isActive, contextUsage } = useMessageStream(sessionId, agentSlug, ['isActive', 'contextUsage'])
  const sendMessage = useSendMessage()
  // Ordinary session reads expose totals to viewers and have already filled
  // the composer's cache. Detailed fields always require the agent's use role.
  const reading = canRead ? query.data : undefined
  const breakdown = reading?.breakdown
  const usage = contextUsage ?? reading?.usage ?? session?.lastUsage
  const total = breakdown?.totalTokens ?? usage?.totalTokens
  const window = breakdown?.rawMaxTokens ?? usage?.contextWindow ?? 0
  const refresh = () => { void query.refresh().catch(() => { /* The query exposes the error for retry. */ }) }
  const used = breakdown?.categories.filter(c => c.kind === 'used') ?? []
  const reserve = breakdown?.categories.filter(c => c.kind === 'buffer' || c.kind === 'free') ?? []
  const deferred = breakdown?.categories.filter(c => c.kind === 'deferred') ?? []
  const percent = total !== undefined && window > 0 ? Math.round(total / window * 100) : null
  const untilCompact = breakdown?.isAutoCompactEnabled && breakdown.autoCompactThreshold
    ? Math.max(0, breakdown.autoCompactThreshold - breakdown.totalTokens)
    : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="context-tray">
      <div className="flex flex-1 min-h-0 flex-col overflow-auto px-5 pb-6 pt-5">
        {total !== undefined && (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-foreground" data-testid="context-percent">
                {percent === null ? 'Context usage' : `${percent}% used`}
              </span>
              <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                {window > 0 ? `${formatTokens(total)} / ${formatTokens(window)}` : `${formatTokens(total)} tokens`}
              </span>
              {canRead && (
                <button type="button" onClick={refresh} disabled={query.isFetching} title="Refresh" aria-label="Refresh"
                  className="rounded-icon p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40">
                  <RefreshCw className={cn('h-3.5 w-3.5', query.isFetching && 'animate-spin')} />
                </button>
              )}
            </div>
            {reading?.capturedAt && (
              <p className="mt-1 text-xs text-muted-foreground" data-testid="context-source">
                {reading.source === 'saved-estimate' ? 'Last recorded estimate' : 'Last recorded count'} ·{' '}
                <time dateTime={reading.capturedAt}>{new Date(reading.capturedAt).toLocaleString()}</time>
              </p>
            )}
          </>
        )}
        {canRead && (query.isError || reading?.refreshFailed) && (
          <div className="mt-2 text-sm text-muted-foreground" role="alert">
            Could not refresh context usage.
            <button type="button" className="ml-2 underline" onClick={refresh} disabled={query.isFetching}>Retry</button>
          </div>
        )}
        {!canRead ? (
          <p className="mt-2 text-sm text-muted-foreground">Detailed context usage requires permission to use this agent.</p>
        ) : !breakdown ? (
          <p className="mt-2 text-sm text-muted-foreground" data-testid="context-unavailable">
            {query.isLoading ? 'Loading context details…' : isActive && contextUsage ? 'Live usage. A category breakdown is unavailable for this measurement.' : total !== undefined
              ? 'Last recorded usage. Category details weren’t saved for this session.'
              : 'This session has no recorded context usage yet.'}
          </p>
        ) : (
          <>
            {/* What is in the window, in order, then the compaction reserve at the far end. */}
            <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden data-testid="context-bar">
              {used.map((category, index) => (
                <span key={category.id ?? index} className={swatchOf(category)} style={{ width: `${(category.tokens / Math.max(1, window)) * 100}%` }} />
              ))}
              <span className="flex-1" />
              {reserve.filter(c => c.kind === 'buffer').map((category, index) => (
                <span key={category.id ?? index} className={swatchOf(category)} style={{ width: `${(category.tokens / Math.max(1, window)) * 100}%` }} />
              ))}
            </div>

            <ul className="mt-4">
              {used.map((category, index) => <Row key={category.id ?? index} category={category} window={window} />)}
            </ul>
            {reserve.length > 0 && (
              <ul className="mt-4">
                {reserve.map((category, index) => <Row key={category.id ?? index} category={category} window={window} />)}
              </ul>
            )}
            {deferred.length > 0 && (
              <ul className="mt-4">
                {deferred.map((category, index) => <Row key={category.id ?? index} category={category} window={window} />)}
              </ul>
            )}

            <ul className="mt-4">
              <Details title="MCP tools" count={breakdown.mcpTools.length}>
                {[...breakdown.mcpTools].sort((a, b) => b.tokens - a.tokens).map(tool => <Item key={tool.name} name={tool.name} tokens={tool.tokens} />)}
              </Details>
              <Details title="Memory files" count={breakdown.memoryFiles.length}>
                {breakdown.memoryFiles.map(file => <Item key={file.path} name={file.path} tokens={file.tokens} />)}
              </Details>
              <Details title="Skills" count={breakdown.skills?.skillFrontmatter.length ?? 0}>
                {(breakdown.skills?.skillFrontmatter ?? []).map(skill => <Item key={skill.name} name={skill.name} tokens={skill.tokens} />)}
              </Details>
            </ul>

            <div className="mt-6 flex items-center gap-3">
              {untilCompact !== null && (
                <span className="text-sm text-muted-foreground" data-testid="context-until-compact">
                  {formatTokens(untilCompact)} until auto-compact
                </span>
              )}
              <button
                type="button"
                onClick={() => sendMessage.mutate({ sessionId, agentSlug, content: '/compact' })}
                disabled={isActive || sendMessage.isPending}
                title={isActive ? 'Available once the agent finishes this turn' : undefined}
                className="ml-auto rounded-control bg-muted px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
                data-testid="context-compact"
              >
                Compact session
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
