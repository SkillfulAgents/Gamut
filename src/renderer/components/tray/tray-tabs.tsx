import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { DrawerTabStrip, drawerTabClassName } from './drawer-tab-strip'
import { cn } from '@shared/lib/utils/cn'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { DropdownMenuItem } from '@renderer/components/ui/dropdown-menu'

/** Which kind of thing a drawer tab shows. Names the tab's test ids too. */
export type TrayTabKind = 'browser' | 'file' | 'workflow' | 'utility' | 'new'

/** One tab in the drawer's strip: a browser page, a file or folder, a workflow run, or an agent's transcript. */
export interface TrayTab {
  key: string
  kind: TrayTabKind
  label: string
  /** Tooltip, when it says more than the label. */
  title?: string
  icon: ReactNode
  /** Drawn at the icon's corner while the tab's subject is live. */
  badge?: ReactNode
  onSelect: () => void
  /** Absent when the tab cannot be closed, such as the page the agent is on. */
  onClose?: () => void
  /** Extra `data-*` attributes for the tab's shell and close button. */
  data?: Record<string, string | undefined>
}

interface TrayTabsProps {
  tabs: TrayTab[]
  frontKey: string | null
  panelId?: string
  /** Whether the front tab's left edge meets the strip's left inset, so the card below can square its corner. */
  onLeadingTabFlush?: (flush: boolean) => void
  /** Drawer-level controls at the strip's right end. */
  trailing?: ReactNode
  /** Follows the last tab until the tabs overflow, then joins `trailing` (DrawerTabStrip). */
  afterTabs?: ReactNode
}

/** The blue dot at a tab icon's corner: something in this tab is running. */
export function TrayTabLiveDot() {
  return <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500" data-testid="tray-tab-live" />
}

/**
 * The drawer's one strip. Every kind of tab shares the same geometry, focus
 * handling and overflow; only the icon, the badge and what closing means differ.
 */
/**
 * The tabs the strip has room for, in order: the first ones, with the front tab taking the last place when it is
 * further along, so the tab being read is always on show. Everything else is in the all-tabs list.
 */
export function shownTabs<T extends { key: string }>(tabs: T[], frontIndex: number, capacity: number): T[] {
  if (tabs.length <= capacity) return tabs
  const shown = tabs.slice(0, capacity)
  if (frontIndex >= capacity) shown[capacity - 1] = tabs[frontIndex]
  return shown
}

export function TrayTabs({ tabs, frontKey, panelId, onLeadingTabFlush, trailing, afterTabs }: TrayTabsProps) {
  const frontIndex = tabs.findIndex(tab => tab.key === frontKey)
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY)
  const shown = shownTabs(tabs, frontIndex, capacity)
  const shownFront = shown.findIndex(tab => tab.key === frontKey)
  const frontButton = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (pendingFocus.current === frontKey && frontKey !== null) {
      frontButton.current?.focus()
      pendingFocus.current = null
    }
  }, [frontKey])

  function navigate(event: KeyboardEvent<HTMLButtonElement>, tab: TrayTab) {
    const index = tabs.indexOf(tab)
    let next: TrayTab
    switch (event.key) {
      case 'ArrowLeft': next = tabs[(index - 1 + tabs.length) % tabs.length]; break
      case 'ArrowRight': next = tabs[(index + 1) % tabs.length]; break
      case 'Home': next = tabs[0]; break
      case 'End': next = tabs[tabs.length - 1]; break
      default: return
    }
    event.preventDefault()
    if (next.key === frontKey) frontButton.current?.focus()
    else pendingFocus.current = next.key
    next.onSelect()
  }
  return (
    <DrawerTabStrip
      inset="sm"
      tabCount={tabs.length}
      activeIndex={shownFront}
      onLeadingTabFlush={onLeadingTabFlush}
      trailing={trailing}
      afterTabs={afterTabs}
      floating
      onCapacity={setCapacity}
      overflowMenu={tabs.map((tab, index) => (
        <DropdownMenuItem
          key={tab.key}
          onSelect={tab.onSelect}
          className={cn('group/item gap-2 pr-1.5', index === frontIndex && 'bg-muted/60')}
          data-testid="tray-tab-all-item"
          aria-current={index === frontIndex || undefined}
          data-active={index === frontIndex || undefined}
        >
          <span className="relative flex shrink-0 items-center">
            {tab.icon}
            {tab.badge}
          </span>
          <span className="min-w-0 flex-1 truncate">{tab.label}</span>
          {tab.onClose && (
            // Closes the tab and leaves the list open, so several can go in a row. Stopping the click keeps the row
            // from also selecting the tab it is closing.
            <button
              type="button"
              aria-label={`Close ${tab.label}`}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                tab.onClose?.()
              }}
              onPointerUp={(event) => event.stopPropagation()}
              className="shrink-0 rounded-icon p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover/item:opacity-100 group-data-[highlighted]/item:opacity-100 touch:opacity-100"
              data-testid="tray-tab-all-close"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </DropdownMenuItem>
      ))}
      label="Tray tabs"
      testId="tray-tab"
    >
      {(reveal) =>
        shown.map((tab, index) => {
          const isFront = index === shownFront
          const testId = `${tab.kind}-tab`
          return (
            <ContextMenu key={tab.key}>
              <ContextMenuTrigger asChild>
                {/* A shell, not a control: it holds the select and close
                    buttons, and a <button> may not contain another. */}
                <div
                  data-testid={testId}
                  data-tray-tab={tab.key}
                  data-active={isFront || undefined}
                  data-tab-first={index === 0 || undefined}
                  {...tab.data}
                  className={drawerTabClassName(index, shownFront, true)}
                >
                  <button
                    type="button"
                    ref={isFront ? frontButton : undefined}
                    aria-pressed={isFront}
                    aria-controls={panelId}
                    onClick={tab.onSelect}
                    onKeyDown={event => navigate(event, tab)}
                    // A clipped tab is still in the tab order, and the strip cannot
                    // rely on the browser to reveal it during a smooth scroll of its
                    // own; bring it in explicitly.
                    onFocus={() => reveal(index)}
                    title={tab.title ?? tab.label}
                    data-testid={`${testId}-select`}
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 pr-1 text-left"
                  >
                    <span className="relative flex shrink-0 items-center">
                      {tab.icon}
                      {tab.badge}
                    </span>
                    {/* Overflowing names fade out at the right edge instead of ellipsizing, as in Chrome. */}
                    <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-16px),transparent)]">
                      {tab.label}
                    </span>
                  </button>
                  {tab.onClose && (
                    <button
                      type="button"
                      data-testid={`${testId}-close`}
                      {...tab.data}
                      aria-label={`Close ${tab.label}`}
                      onClick={tab.onClose}
                      className={cn(
                        'shrink-0 rounded-icon p-0.5 text-muted-foreground transition-opacity hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100 focus:opacity-100 touch:opacity-100',
                        // The front tab keeps its close visible; the rest reveal it on hover.
                        isFront ? 'opacity-100' : 'opacity-0',
                      )}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem disabled={!tab.onClose} onClick={tab.onClose}>
                  Close tab
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })
      }
    </DrawerTabStrip>
  )
}
