import { useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { QueryObserver, useQueries, useQueryClient } from '@tanstack/react-query'
import { Bot, Search } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@renderer/components/ui/dialog'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { AnimatedNavIcon } from '@renderer/components/ui/animated-nav-icon'
import { settingsPagesFor, useSettingsAudience } from '@renderer/components/settings/settings-catalog'
import { AgentAvatarWithBadge } from '@renderer/components/agents/agent-avatar/agent-avatar-with-badge'
import { WorkingDots } from '@renderer/components/agents/status-indicators'
import { useAgents, type ApiAgent } from '@renderer/hooks/use-agents'
import { isSearchShortcut, useSearch, useSearchOpen } from '@renderer/context/search-context'
import { useDialogs } from '@renderer/context/dialog-context'
import { useIsMobile } from '@renderer/hooks/use-mobile'
import { allSessionsQueryOptions } from '@renderer/hooks/use-sessions'
import { useNavigate } from '@tanstack/react-router'
import type { ApiSession } from '@shared/lib/types/api'
import { agentAvatarState } from '@shared/lib/types/agent-activity-status'
import { cn } from '@shared/lib/utils/cn'
import { compactAgo } from '@renderer/lib/last-run'
import { flattenSections, getRecent, searchAll, type FlatItem, type SearchSections } from './filter'
import type { SettingsResult } from './settings-match'

const NO_RESULTS: SearchSections = { agents: [], sessions: [], dashboards: [], settings: [] }

type KeyHandler = (e: KeyboardEvent) => void

const NO_SESSIONS: ApiSession[] = []

/**
 * Rendered inside the router, so it can use the `useNavigate` hook directly.
 * Open state comes from SearchContext, which lives above the router.
 *
 * This is only the frame. It stays mounted once search has been opened, so it
 * reads nothing but the open state; everything that reads agents and sessions
 * is in `SearchPalette`, which Radix mounts with the dialog's content and
 * unmounts when its exit animation ends.
 */
export function SearchDialog() {
  const open = useSearchOpen()
  const { openSearch, closeSearch } = useSearch()
  // The keys are handled on the dialog's content element, where they always
  // were, by the palette inside it, which knows the rows.
  const keyHandler = useRef<KeyHandler | null>(null)

  const handleKeyDown: KeyHandler = (e) => {
    // `DialogContent` keeps its keys from `window`, where the provider listens
    // for cmd/ctrl-K, so it is toggled here. That includes the moment the
    // content is still up after closing (its exit animation, with focus still
    // in the field), when a cmd/ctrl-K must open search again.
    if (isSearchShortcut(e)) {
      e.preventDefault()
      if (open) closeSearch()
      else openSearch()
      return
    }
    keyHandler.current?.(e)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeSearch() }}>
      {/* Installed-PWA full-bleed: the box is top-anchored (top-4), so a top margin of the
          safe-area inset drops the whole palette (input + close X) below the Dynamic Island.
          env() is 0 on desktop / non-standalone mobile Safari; md: resets it (desktop centers). */}
      <DialogContent
        // A fixed 640 by 560 box (narrower or shorter only when the window is), so it
        // holds still as results come and go; the list scrolls inside it.
        className="search-anim flex h-[560px] max-w-[640px] flex-col p-0 gap-0 overflow-hidden top-4 translate-y-0 mt-[env(safe-area-inset-top)] md:top-[50%] md:-translate-y-1/2 md:mt-0 [&>button]:top-6 [&>button]:right-5 md:[&>button]:hidden"
        onKeyDown={handleKeyDown}
        aria-label="Search agents, sessions, dashboards, and settings"
      >
        <DialogTitle className="sr-only">Search agents, sessions, dashboards, and settings</DialogTitle>
        <DialogDescription className="sr-only">Find agents, sessions, and dashboards by name, and settings pages by what is on them</DialogDescription>
        <SearchPalette open={open} closeSearch={closeSearch} keyHandler={keyHandler} />
      </DialogContent>
      {!open && <HeldSessionLists />}
    </Dialog>
  )
}

/**
 * Keeps the session lists search has read in the query cache while search is
 * closed, so the next open shows them at once and reads again behind them (the
 * palette holds them itself while it is mounted). It only holds: an observer that is disabled and never notifies neither
 * fetches nor renders anything. An agent that leaves the list is let go, and
 * its sessions are collected as any unobserved query is.
 */
function HeldSessionLists() {
  const queryClient = useQueryClient()
  const { data: slugs } = useAgents({ select: slugsOf, poll: false })
  useEffect(() => {
    const release = (slugs ?? []).map((slug) =>
      new QueryObserver(queryClient, { queryKey: ['sessions', slug], enabled: false, notifyOnChangeProps: [] })
        .subscribe(() => {}),
    )
    return () => release.forEach((unsubscribe) => unsubscribe())
  }, [queryClient, slugs])
  return null
}

function slugsOf(agents: ApiAgent[]): string[] {
  return agents.map((agent) => agent.slug)
}

/** `next`, or the value last returned if `next` has the same keys holding the same values. */
function useSameWhileEqual<T>(next: Record<string, T>): Record<string, T> {
  const held = useRef(next)
  if (!sameEntries(held.current, next)) held.current = next
  return held.current
}

function sameEntries<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key])
}

/**
 * The field and the results. Mounted only while the dialog's content is: a
 * closed dialog renders and sorts nothing. `open` is false here only during
 * the exit animation.
 */
function SearchPalette({
  open,
  closeSearch,
  keyHandler,
}: {
  open: boolean
  closeSearch: () => void
  keyHandler: RefObject<KeyHandler | null>
}) {
  const { openSettings } = useDialogs()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const { data: agents } = useAgents({ poll: false })
  // Only the settings pages this viewer's nav shows them.
  const { isAuthMode, isAdmin, computerUse } = useSettingsAudience()
  const settingsPages = useMemo(
    () => settingsPagesFor({ isAuthMode, isAdmin, computerUse }),
    [isAuthMode, isAdmin, computerUse]
  )

  const queryClient = useQueryClient()
  const sessionQueries = useQueries({
    queries: (agents ?? []).map((a) => ({
      ...allSessionsQueryOptions(queryClient, a.slug),
      enabled: open,
      staleTime: 30_000,
    })),
  })
  // `useQueries` returns a new array on every render. The map built from it is
  // the same object until a list's rows change, so moving the selection (arrow
  // keys, the pointer over a row) does not filter and sort every session again.
  // Not `combine`: that runs once per list that arrives, over every agent, so
  // opening with N agents would cost N squared; here React batches the lists
  // that arrive together into one render, and a render walks the agents once.
  const sessionsByAgent = useSameWhileEqual(
    Object.fromEntries((agents ?? []).map((a, i) => [a.slug, sessionQueries[i]?.data ?? NO_SESSIONS])),
  )

  // Reset state on open
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // On mobile, dismissing the soft keyboard (the keyboard's "down" button, or a
  // tap outside the field) is a natural "done searching" gesture — close the
  // overlay. iOS has no keyboard event, but the VisualViewport shrinks while the
  // keyboard is up and returns to full height once it's dismissed; we close on
  // that shown→hidden transition. Tapping a result keeps the keyboard up (it
  // doesn't blur the input), so this won't pre-empt selection.
  useEffect(() => {
    const vv = window.visualViewport
    if (!open || !isMobile || !vv) return
    let keyboardWasShown = false
    const onResize = () => {
      const occluded = window.innerHeight - vv.height
      if (occluded > 120) {
        keyboardWasShown = true
      } else if (keyboardWasShown) {
        closeSearch()
      }
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [open, isMobile, closeSearch])

  const trimmedQuery = query.trim()
  const isSearchMode = trimmedQuery.length > 0

  // Settings match without the agents loaded, so they are not waited on.
  const sections = useMemo<SearchSections>(() => {
    if (isSearchMode) return searchAll(agents ?? [], sessionsByAgent, query, settingsPages)
    return agents ? getRecent(agents, sessionsByAgent) : NO_RESULTS
  }, [agents, sessionsByAgent, query, isSearchMode, settingsPages])

  const flatItems = useMemo<FlatItem[]>(() => flattenSections(sections), [sections])

  // Clamp activeIndex when result list shrinks
  useEffect(() => {
    setActiveIndex((idx) =>
      flatItems.length === 0 ? 0 : Math.min(idx, flatItems.length - 1)
    )
  }, [flatItems.length])

  // Keep the active item visible as the user navigates. Not on mount: the
  // list opens at its top with the first row selected, and nothing has moved.
  const shownIndex = useRef(activeIndex)
  useEffect(() => {
    if (shownIndex.current === activeIndex) return
    shownIndex.current = activeIndex
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleSelect = (item: FlatItem) => {
    // Close the dialog BEFORE navigating: the route transition otherwise strands
    // the Radix overlay open (it intercepts pointer events on the page beneath).
    closeSearch()
    if (item.kind === 'settings') {
      // Records where the palette was opened from as Settings' Back target
      // (or keeps the one it has, when opened over Settings).
      openSettings(item.result.page.id)
    } else if (item.kind === 'agent') {
      void navigate({ to: '/agents/$slug', params: { slug: item.agent.slug } })
    } else if (item.kind === 'dashboard') {
      void navigate({
        to: '/agents/$slug/dashboards/$dashSlug',
        params: { slug: item.agent.slug, dashSlug: item.dashboard.slug },
      })
    } else {
      void navigate({
        to: '/agents/$slug/sessions/$sessionId',
        params: { slug: item.agent.slug, sessionId: item.session.id },
      })
    }
  }

  const handleKeyDown: KeyHandler = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (flatItems.length === 0 ? 0 : (i + 1) % flatItems.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) =>
        flatItems.length === 0 ? 0 : (i - 1 + flatItems.length) % flatItems.length
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatItems[activeIndex]
      if (item) handleSelect(item)
    }
  }

  useImperativeHandle(keyHandler, () => handleKeyDown)

  return (
    <>
      {/* The header is the field alone: large type, no rule beneath it, and from md
          no close button (Escape or a click outside closes; touch keeps the X, so
          the field leaves room for it). Its icon sits on the rows' left edge. */}
      <div className="flex shrink-0 items-center gap-4 pb-3 pl-6 pr-12 pt-5 md:pr-6">
        <Search className="h-[18px] w-[18px] shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActiveIndex(0)
          }}
          placeholder="Search agents, sessions, dashboards, and settings..."
          className="min-w-0 flex-1 bg-transparent text-lg outline-none placeholder:text-muted-foreground/60"
          data-testid="search-input"
        />
      </div>
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        data-testid="search-results"
      >
        {flatItems.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {isSearchMode ? 'No matches found' : 'No recent agents'}
          </div>
        ) : (
          <>
            <ResultSection label={isSearchMode ? 'Agents' : 'Recent agents'} count={sections.agents.length}>
              {sections.agents.map((agent, i) => (
                <ResultRow
                  key={agent.slug}
                  index={i}
                  active={activeIndex === i}
                  agent={agent}
                  title={<HighlightMatch text={agent.name} query={trimmedQuery} />}
                  subtitle={lastActive(agent.lastActivityAt)}
                  onSelect={() => handleSelect({ kind: 'agent', agent })}
                  onActivate={setActiveIndex}
                  data-testid="search-agent-row"
                  data-agent-name={agent.name}
                  data-agent-slug={agent.slug}
                />
              ))}
            </ResultSection>
            <ResultSection label={isSearchMode ? 'Sessions' : 'Recent sessions'} count={sections.sessions.length}>
              {sections.sessions.map(({ agent, session }, i) => {
                const index = sections.agents.length + i
                return (
                  <ResultRow
                    key={session.id}
                    index={index}
                    active={activeIndex === index}
                    agent={agent}
                    owned
                    title={<HighlightMatch text={session.name} query={trimmedQuery} />}
                    subtitle={`${agent.name} · ${compactAgo(session.lastActivityAt)}`}
                    onSelect={() => handleSelect({ kind: 'session', agent, session })}
                    onActivate={setActiveIndex}
                    data-testid="search-session-row"
                    data-agent-name={agent.name}
                    data-agent-slug={agent.slug}
                    data-session-name={session.name}
                    data-session-id={session.id}
                  />
                )
              })}
            </ResultSection>
            <ResultSection label="Dashboards" count={sections.dashboards.length}>
              {sections.dashboards.map(({ agent, dashboard }, i) => {
                const index = sections.agents.length + sections.sessions.length + i
                return (
                  <ResultRow
                    key={`${agent.slug}/${dashboard.slug}`}
                    index={index}
                    active={activeIndex === index}
                    agent={agent}
                    owned
                    title={<HighlightMatch text={dashboard.name} query={trimmedQuery} />}
                    subtitle={agent.name}
                    onSelect={() => handleSelect({ kind: 'dashboard', agent, dashboard })}
                    onActivate={setActiveIndex}
                    data-testid="search-dashboard-row"
                    data-agent-name={agent.name}
                    data-agent-slug={agent.slug}
                    data-dashboard-name={dashboard.name}
                    data-dashboard-slug={dashboard.slug}
                  />
                )
              })}
            </ResultSection>
            <ResultSection label="Settings" count={sections.settings.length}>
              {sections.settings.map((result, i) => {
                const index = sections.agents.length + sections.sessions.length + sections.dashboards.length + i
                return (
                  <SettingsResultRow
                    key={result.page.id}
                    index={index}
                    active={activeIndex === index}
                    result={result}
                    query={trimmedQuery}
                    onSelect={() => handleSelect({ kind: 'settings', result })}
                    onActivate={setActiveIndex}
                  />
                )
              })}
            </ResultSection>
          </>
        )}
      </div>
    </>
  )
}

/** An agent row's second line, with the age in its compact form: "Last active 4m ago". */
function lastActive(date: ApiAgent['lastActivityAt']): string {
  const ago = compactAgo(date)
  if (!ago) return 'Never active'
  return ago === 'now' ? 'Last active just now' : `Last active ${ago} ago`
}

/** A labelled run of rows. Nothing is drawn for a section with no rows, label included. */
function ResultSection({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null
  return (
    // Space above a section sets it apart from the one before; the first needs
    // only a little, under the header.
    <div role="group" aria-label={label} data-testid="search-section" data-section={label} className="mt-6 first:mt-2">
      <div className="px-3 pb-2 pt-2 text-xs text-muted-foreground" aria-hidden="true">
        {label}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}

/**
 * One result, on two lines: its name, and a muted line beneath. An agent's row
 * leads with its avatar and says when it was last active. A session or a
 * dashboard (`owned`) belongs to an agent, so its second line names that agent
 * behind a small avatar, and the row itself has none.
 */
function ResultRow({
  index,
  active,
  agent,
  owned = false,
  title,
  subtitle,
  onSelect,
  onActivate,
  ...data
}: {
  index: number
  active: boolean
  agent: ApiAgent
  owned?: boolean
  title: React.ReactNode
  subtitle: string
  onSelect: () => void
  onActivate: (index: number) => void
} & Record<`data-${string}`, string>) {
  const state = agentAvatarState(agent)
  const avatar = (
    <AgentAvatarWithBadge
      agent={agent}
      state={state}
      size={owned ? 14 : 28}
      fallback={state === 'working'
        ? <WorkingDots />
        : <Bot className={cn('text-muted-foreground', owned ? 'size-3.5' : 'size-7 p-0.5', state === 'sleeping' && 'opacity-50')} aria-hidden />}
    />
  )
  return (
    <button
      type="button"
      data-index={index}
      onClick={onSelect}
      // Move, not enter: a row that scrolls under a resting pointer during
      // keyboard navigation must not take the selection.
      onMouseMove={() => onActivate(index)}
      className={cn(
        'flex w-full items-center gap-4 rounded-item px-3 py-2.5 text-left',
        active && 'bg-accent text-accent-foreground'
      )}
      {...data}
    >
      {!owned && avatar}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/70">
          {owned && avatar}
          <span className="truncate">{subtitle}</span>
          {(state === 'idle' || state === 'sleeping' || (state === 'working' && agent.avatar)) && (
            <span className={cn('sr-only', state === 'working' && 'motion-reduce:not-sr-only motion-reduce:shrink-0')}>
              ({state})
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

/**
 * A settings page, on two lines like the rows above it: the page's name behind
 * its nav icon, and beneath, the nav group it sits in and, when the page was
 * listed for something on it rather than its name, that ("Anthropic").
 */
function SettingsResultRow({
  index,
  active,
  result,
  query,
  onSelect,
  onActivate,
}: {
  index: number
  active: boolean
  result: SettingsResult
  query: string
  onSelect: () => void
  onActivate: (index: number) => void
}) {
  const { page, matched } = result
  return (
    <button
      type="button"
      data-index={index}
      onClick={onSelect}
      // Move, not enter: as for the rows above.
      onMouseMove={() => onActivate(index)}
      className={cn(
        'flex w-full items-center gap-4 rounded-item px-3 py-2.5 text-left',
        active && 'bg-accent text-accent-foreground'
      )}
      data-testid="search-settings-row"
      data-settings-tab={page.id}
    >
      {/* The size of an agent's avatar, so every row's name starts at one edge. */}
      {/* h-7, not size-7: the height is what rounded-control's radius follows. */}
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-control border bg-muted/40 text-muted-foreground">
        <AnimatedNavIcon name={page.icon} className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">
          <HighlightMatch text={page.label} query={query} />
        </span>
        <span className="block truncate text-xs text-muted-foreground/70">
          {page.group}
          {matched && (
            <>
              {' · '}
              <HighlightMatch text={matched} query={query} />
            </>
          )}
        </span>
      </span>
    </button>
  )
}
