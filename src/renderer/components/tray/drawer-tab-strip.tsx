import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
import { cn } from '@shared/lib/utils/cn'

interface DrawerTabStripProps {
  tabCount: number
  label?: string
  /** Match the inset of the content card below the tabs. */
  inset?: 'sm' | 'md'
  activeIndex: number
  onLeadingTabFlush?: (flush: boolean) => void
  trailing?: ReactNode
  /**
   * A control that follows the last tab (the drawer's +), as in Chrome. Once the tabs overflow it moves beside
   * `trailing`, and a placeholder of its width stays behind so the overflow it caused does not undo itself.
   */
  afterTabs?: ReactNode
  /**
   * Chrome's tabs without the gray rail: they stand on the page above the drawer's card (tray-card.ts), and the
   * front tab, white with the card's faint edge, joins it.
   */
  floating?: boolean
  /**
   * The strip never scrolls: it holds as many tabs as fit at a readable width, and a down chevron opening this list
   * of every tab takes the place of the scroll arrows, as in Chrome's tab search. The caller shows only as many of
   * its tabs as `onCapacity` reports room for; the rest are reached from the list.
   */
  overflowMenu?: ReactNode
  /** How many tabs fit at a readable width, whenever that changes. Only with `overflowMenu`. */
  onCapacity?: (capacity: number) => void
  testId: string
  children: (reveal: (index: number) => void) => ReactNode
}

/** Shared scrolling, focus reveal, overflow controls, and card alignment for drawer tabs. */
const TAB_GAP_PX = 1
/** Sub-pixel slack: a scroller's scrollLeft rarely lands exactly on its maximum. */
const EDGE_EPSILON_PX = 1
// The overflow calculation and the rendered tabs use the same minimum widths.
export const fittedTabMinWidth = { active: 120, inactive: 84 } as const
/** Room the + (or the all-tabs count and chevron in its place) takes while it follows the last tab. */
const AFTER_TABS_PX = 44

export function DrawerTabStrip({
  tabCount,
  label,
  inset = 'md',
  activeIndex,
  onLeadingTabFlush,
  trailing,
  afterTabs,
  floating = false,
  overflowMenu,
  onCapacity,
  testId,
  children,
}: DrawerTabStripProps) {
  const groupRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef<HTMLDivElement>(null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [maxScroll, setMaxScroll] = useState(0)
  const fitTabs = !!overflowMenu
  /** How many tabs fit at their minimum widths. */
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY)

  /**
   * How far the strip can scroll (the content width beyond the visible group), and, for a strip that fits its tabs
   * instead, how many it has room for.
   */
  const measure = useCallback(() => {
    const group = groupRef.current
    if (!group) return
    setMaxScroll(Math.max(0, group.scrollWidth - group.clientWidth))
    setScrollLeft(group.scrollLeft)
    if (!fitTabs || group.clientWidth === 0) return
    // Reserve space for the + or overflow button. Counts with more digits can widen that button.
    const overflowWidth = Math.ceil(overflowRef.current?.getBoundingClientRect().width ?? 0) + TAB_GAP_PX
    const room = group.clientWidth - Math.max(AFTER_TABS_PX, overflowWidth) - fittedTabMinWidth.active
    setCapacity(1 + Math.max(0, Math.floor(room / (fittedTabMinWidth.inactive + TAB_GAP_PX))))
  }, [fitTabs])
  const crowded = fitTabs && tabCount > capacity
  const hiddenCount = crowded ? tabCount - capacity : 0
  useEffect(() => {
    if (fitTabs) onCapacity?.(capacity)
  }, [fitTabs, onCapacity, capacity])

  // The active tab is wider than the rest, so selecting one changes the content
  // width as well as adding or removing a tab does.
  useLayoutEffect(() => {
    measure()
  }, [measure, tabCount, activeIndex, hiddenCount])

  useEffect(() => {
    const group = groupRef.current
    if (!group || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measure())
    observer.observe(group)
    return () => observer.disconnect()
  }, [measure])

  /** Scroll just far enough to bring a tab fully into the strip. */
  const reveal = useCallback((index: number) => {
    const group = groupRef.current
    const track = trackRef.current
    const tab = track?.children[index] as HTMLElement | undefined
    if (!group || !track || !tab) return
    // offsetLeft is measured against the positioned strip, not the scroll
    // content; subtracting the track's own offset puts both on the same axis
    // as scrollLeft.
    const left = tab.offsetLeft - track.offsetLeft
    const right = left + tab.offsetWidth
    if (left < group.scrollLeft) {
      group.scrollTo({ left, behavior: 'smooth' })
    } else if (right > group.scrollLeft + group.clientWidth) {
      group.scrollTo({ left: right - group.clientWidth, behavior: 'smooth' })
    }
  }, [])

  useLayoutEffect(() => {
    reveal(activeIndex)
  }, [reveal, activeIndex, tabCount])

  const atStart = scrollLeft <= EDGE_EPSILON_PX
  const atEnd = scrollLeft >= maxScroll - EDGE_EPSILON_PX
  // A strip that fits its tabs never scrolls, so the + always follows the last tab.
  const overflowing = !fitTabs && maxScroll > 0

  useEffect(() => {
    onLeadingTabFlush?.(activeIndex === 0 && atStart)
  }, [onLeadingTabFlush, activeIndex, atStart])

  /**
   * One tab's worth of travel. The active tab is deliberately wider than its
   * neighbours, so a step measured off it would overshoot; sample another.
   */
  const step = () => {
    const children = Array.from(trackRef.current?.children ?? []) as HTMLElement[]
    const sample = children.find((_, index) => index !== activeIndex) ?? children[0]
    return (sample?.offsetWidth ?? 160) + TAB_GAP_PX
  }
  const slide = (direction: -1 | 1) => {
    groupRef.current?.scrollBy({ left: direction * step(), behavior: 'smooth' })
  }

  const allTabs = crowded && (
    <div ref={overflowRef} className="flex h-8 shrink-0 items-center pl-0.5 text-muted-foreground">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`All tabs, ${hiddenCount} more`}
            title="All tabs"
            className="inline-flex items-center gap-0.5 rounded-icon px-1 py-1 transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
            data-testid={`${testId}-all`}
          >
            {/* How many tabs are only in the list. */}
            <span className="text-xs tabular-nums" data-testid={`${testId}-hidden-count`}>{hiddenCount}</span>
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[60vh] w-64 overflow-y-auto" data-testid={`${testId}-all-menu`}>
          {overflowMenu}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
  // While some tabs are only in the list, its chevron follows the last tab shown and the + steps over to the
  // drawer's controls; otherwise the + follows the tabs, as in Chrome.
  const plusInTrailing = overflowing || crowded

  return (
    <div
      role={label ? 'group' : undefined}
      aria-label={label}
      // The first tab's left edge meets the content card's square corner.
      className={cn(
        'group/strip relative flex shrink-0 items-end pt-1.5',
        // Floating, the drawer's own 8px gutter is the strip's inset, so the first tab lines up with the card.
        floating ? 'pl-0 pr-0' : cn('bg-muted/60', inset === 'sm' ? 'pl-2 pr-0' : 'pl-4 pr-2'),
      )}
      data-testid={`${testId}-bar`}
      data-overflowing={overflowing || undefined}
    >
      {/* A first tab at the back stands on the card's rounded corner with a square foot. Its fill carries on into
          the notch the curve leaves, behind the card (which paints over it, being later and positioned), so the
          tab wraps the corner instead of hanging past it. The front tab joins a squared corner and needs none. */}
      {floating && tabCount > 0 && activeIndex !== 0 && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute left-0 top-full h-[var(--radius-card)] w-[var(--radius-card)] transition-colors',
            'bg-black/[0.04] dark:bg-white/[0.05]',
            // Darkens with the tab it continues (a caller marks its first tab `data-tab-first`).
            'group-has-[[data-tab-first]:hover]/strip:bg-black/[0.07] dark:group-has-[[data-tab-first]:hover]/strip:bg-white/[0.08]',
          )}
          data-testid={`${testId}-corner`}
        />
      )}

      {/* Bounded to the space left after the arrows and trailing control.
          pb-px/-mb-px holds the active tab's 1px overhang without letting the
          vertical axis overflow. */}
      <div
        ref={groupRef}
        onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
        className={cn('file-tab-scroller min-w-0 flex-1 -mb-px overflow-y-hidden pb-px', fitTabs ? 'overflow-x-hidden' : 'overflow-x-auto')}
        data-testid={`${testId}-group`}
      >
        <div ref={trackRef} className="flex w-full items-end gap-px">
          {children(reveal)}
          {allTabs}
          {afterTabs && (overflowing
            ? <span aria-hidden="true" className="h-8 w-7 shrink-0" />
            : !crowded && <div className="flex h-8 shrink-0 items-center pl-1 text-muted-foreground">{afterTabs}</div>)}
        </div>
      </div>

      {overflowing && (
        <div className="flex h-8 shrink-0 items-center pl-1 text-muted-foreground" data-testid={`${testId}-arrows`}>
          <button
            type="button"
            onClick={() => slide(-1)}
            disabled={atStart}
            aria-label="Earlier tabs"
            className="rounded-icon p-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => slide(1)}
            disabled={atEnd}
            aria-label="Later tabs"
            className="rounded-icon p-0.5 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* The strip's right padding plus the control's 8px inset aligns it with the content card. */}
      {trailing && (
        <div className="ml-auto flex h-8 shrink-0 items-center gap-1 pl-1 pr-1.5 text-muted-foreground">
          {plusInTrailing && afterTabs}
          {trailing}
        </div>
      )}
    </div>
  )
}

/** Shared tab geometry; icons, menus, and close behavior belong to each caller. */
export function drawerTabClassName(index: number, activeIndex: number, floating = false) {
  return cn(
    // flex-basis 160px is also each tab's widest: tabs share the strip until they reach it. Floating, a tab's top
    // corners take the card's radius, so the front tab and the card it joins are rounded alike.
    'group relative flex h-8 flex-[0_1_160px] items-center pr-2 text-left text-xs transition-colors',
    floating ? 'rounded-t-card' : 'rounded-t-control',
    index === activeIndex
      ? cn(
          'z-10 min-w-[9.5rem] -mb-px bg-background text-foreground',
          // The selected tab joins the panel with its fill and shadow, plus a faint outline in dark mode.
          floating
            ? cn(
                'shadow-[0_-1px_3px_-1px_rgba(15,23,42,0.06)] dark:border dark:border-b-0 dark:shadow-none',
                index === 0 ? 'tray-leading-tab dark:border-transparent dark:border-r-white/5' : 'dark:border-white/5',
              )
            : 'border border-b-0 border-black/5 shadow-[0_-1px_2px_rgba(0,0,0,0.04)] dark:border-white/5',
        )
      // Floating, a tab at the back keeps a faint fill of its own, so it reads as a tab and not loose text, and
      // darkens a step on hover; the fill also divides neighbours, so they need no separator.
      : cn(
          'min-w-[4.25rem] text-foreground',
          floating
            ? 'bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08]'
            : 'hover:bg-background/60',
        ),
    !floating &&
      index > 0 &&
      index !== activeIndex &&
      index - 1 !== activeIndex &&
      'before:absolute before:left-0 before:top-2 before:bottom-2 before:w-px before:bg-border/60',
  )
}
