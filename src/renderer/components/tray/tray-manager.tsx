import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, Minimize2, PanelRight, PanelRightOpen, Plus, X } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { DrawerShell } from './drawer-shell'
import { TrayTabs } from './tray-tabs'
import { TrayEmptyState } from './tray-empty-state'
import { TRAY_PANEL_CLASS } from './tray-card'
import { describeTrayTab } from './session-tray-tabs'
import { trayResidents } from './tray-residents'
import { useRequiredTray, useTrayState } from '@renderer/context/session-tray-context'
import { useHeaderTraySlot } from '@renderer/components/layout/content-shell'
import { useSidebar } from '@renderer/components/ui/sidebar'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { onAgentInvoked } from '@renderer/hooks/use-invocations'
import { BrowserTrayContent, type BrowserPageActions, type BrowserPages } from '@renderer/components/browser/browser-tray-content'
import { FilePreviewTrayContent } from '@renderer/components/file-preview/file-preview-tray-content'
import { WorkflowTrayContent } from '@renderer/components/workflow/workflow-tray-content'

const DRAWER_STORAGE_KEY = 'tray_drawer_width'

export interface TrayManagerProps {
  agentSlug: string
  sessionId: string
  browserActive: boolean | null
  /**
   * A session's own drawer: Hide keeps the tabs behind a button, and the tabs
   * are there again when the session is reopened. Off for a home page's
   * preview drawer, where hiding closes it.
   */
  persistent?: boolean
  /** Wide screens split the layout by default; Agent Home opts into an overlay. */
  filePreviewWideLayout?: 'split' | 'overlay'
  /** Draw the drawer at its minimum width while true. */
  narrowDrawer?: boolean
  /** Called as the person drags the drawer's edge. */
  onDrawerResize?: () => void
}

/**
 * The side drawer: one strip of tabs over one body. A tab is a thing to look
 * at (a browser page, a file or folder, a workflow run, the session's subagents),
 * so moving between them never closes the drawer or swaps it for another.
 */
export function TrayManager({
  agentSlug,
  sessionId,
  browserActive,
  persistent = false,
  filePreviewWideLayout = 'split',
  narrowDrawer = false,
  onDrawerResize,
}: TrayManagerProps) {
  const tray = useRequiredTray()
  const { tabs, selected: front, hidden } = useTrayState(tray)
  const { closeTab, openFile, openFolder } = useFilePreview()
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()
  const headerSlot = useHeaderTraySlot()
  const pageActionsRef = useRef<BrowserPageActions | null>(null)
  const viewed = useRef<string | null>(null)
  const onPagesChange = useCallback((pages: BrowserPages | null) => {
    if (!pages) return
    viewed.current = pages.viewingTargetId ?? pages.tabs.find(page => page.active)?.targetId ?? null
    tray.syncBrowser(pages.tabs, viewed.current)
  }, [tray])
  useEffect(() => { tray.browserAvailable(browserActive) }, [tray, browserActive])
  useEffect(() => {
    if (!persistent) return
    return onAgentInvoked(sessionId, () => {
      const { selected, tabs, hidden } = tray.snapshot()
      const front = tabs.find(tab => tab.key === selected)
      if (!hidden && front?.kind === 'utility' && front.id === 'invoked-agents') return
      tray.openUtility('invoked-agents', null)
    })
  }, [persistent, sessionId, tray])
  const frontTab = tabs.find(tab => tab.key === front)
  const targetId = frontTab?.kind === 'browser' ? frontTab.page?.targetId : null
  useEffect(() => {
    if (targetId && targetId !== viewed.current) pageActionsRef.current?.select(targetId)
  }, [targetId])
  const panelId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const drawerRef = useRef<HTMLDivElement>(null)
  const focusAfterClose = useRef<string | null>(null)
  useLayoutEffect(() => {
    const closing = focusAfterClose.current
    if (!closing || tabs.some(tab => tab.key === closing)) return
    focusAfterClose.current = null
    // A browser page may close asynchronously. Respect focus moved elsewhere in the meantime.
    if (document.activeElement !== document.body) return
    const next = drawerRef.current?.querySelector<HTMLButtonElement>('[data-active="true"] button[aria-pressed="true"]')
    const destination = next ?? toggleRef.current
    destination?.focus()
  }, [tabs])
  const orderedTabs = tabs.map(tab => describeTrayTab(tab, { agentSlug, sessionId }, () => tray.select(tab.key), () => {
    if (drawerRef.current?.contains(document.activeElement)) focusAfterClose.current = tab.key
    if (tab.kind === 'browser' && tab.page) pageActionsRef.current?.close(tab.page.targetId)
    else if (tab.kind === 'file') closeTab(tab.key)
    else tray.close(tab.key)
  }))
  const [leadingTabFlush, setLeadingTabFlush] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const sidebarWasOpenRef = useRef(false)
  // Leaving full screen restores the sidebar. It runs from the button, from
  // Escape, and from every path that takes the drawer away underneath it,
  // otherwise the sidebar stays folded with nothing on screen to unfold it.
  // Tracked in a ref as well as state so exit can read it without going
  // through an updater: a sibling's setState must not run inside one.
  const isExpandedRef = useRef(false)
  const exitFullScreen = useCallback(() => {
    if (!isExpandedRef.current) return
    isExpandedRef.current = false
    setIsExpanded(false)
    if (sidebarWasOpenRef.current) setSidebarOpen(true)
  }, [setSidebarOpen])

  const handleToggleExpand = useCallback(() => {
    if (isExpanded) {
      exitFullScreen()
    } else {
      sidebarWasOpenRef.current = sidebarOpen
      isExpandedRef.current = true
      setSidebarOpen(false)
      setIsExpanded(true)
    }
  }, [isExpanded, sidebarOpen, setSidebarOpen, exitFullScreen])

  // Canvas input and local dialogs own their handled keys; only an unhandled Escape exits.
  useEffect(() => {
    if (!isExpanded) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      exitFullScreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isExpanded, exitFullScreen])

  const restoreSidebar = useRef(setSidebarOpen)
  restoreSidebar.current = setSidebarOpen
  useEffect(() => () => {
    if (isExpandedRef.current && sidebarWasOpenRef.current) restoreSidebar.current(true)
  }, [])
  const isEmpty = tabs.length === 0
  useEffect(() => { if (isEmpty) exitFullScreen() }, [isEmpty, exitFullScreen])
  const handleHide = () => {
    exitFullScreen()
    tray.hide()
  }
  const drawerShown = !isEmpty && !hidden
  // The drawer mounts closed and opens on the next frame, so its width animates in.
  const wantOpen = drawerShown
  const [isOpen, setIsOpen] = useState(false)
  useEffect(() => {
    if (!wantOpen) {
      setIsOpen(false)
      return
    }
    const frame = requestAnimationFrame(() => setIsOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [wantOpen])

  const utility = frontTab?.kind === 'utility' ? trayResidents.find(item => item.id === frontTab.id) : undefined
  return (
    <>
      {headerSlot && createPortal(
        // The drawer's one toggle, always in the header: lit while the drawer is open. Hidden
        // tabs are named in its label for screen readers only; the button shows just the icon.
        <button
          type="button"
          onClick={() => {
            if (drawerShown) handleHide()
            else tray.show()
          }}
          className={cn(
            'flex h-[30px] items-center gap-1 rounded-[calc(var(--radius-icon)+1px)] px-2 transition-colors hover:bg-muted hover:text-foreground',
            drawerShown ? 'bg-muted text-foreground' : 'text-muted-foreground',
          )}
          title={drawerShown ? 'Hide panel' : 'Show panel'}
          aria-label={
            drawerShown ? 'Hide panel'
              : isEmpty ? 'Show panel'
                : `Show panel, ${orderedTabs.length} ${orderedTabs.length === 1 ? 'tab' : 'tabs'}`
          }
          aria-pressed={drawerShown}
          ref={toggleRef}
          data-testid={drawerShown ? 'tray-hide' : 'tray-show'}
        >
          <PanelRight className="h-4 w-4" />
        </button>,
        headerSlot,
      )}
      {!headerSlot && ((hidden && persistent) || (persistent && isEmpty)) && (
        <div className="h-full flex items-start pt-2 pr-1 shrink-0">
          <button
            type="button"
            onClick={() => tray.show()}
            className="flex items-center gap-1 p-1.5 rounded-item hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title="Show panel"
            aria-label={`Show panel, ${orderedTabs.length} ${orderedTabs.length === 1 ? 'tab' : 'tabs'}`}
            ref={toggleRef}
            data-testid="tray-show"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
        </div>
      )}
      {!isEmpty && (persistent || !hidden) && <DrawerShell
        isOpen={isOpen}
        storageKey={DRAWER_STORAGE_KEY}
        responsiveFullWidth
        floating
        wideOverlay={filePreviewWideLayout === 'overlay'}
        fullScreen={isExpanded}
        narrow={narrowDrawer}
        onResize={onDrawerResize}
        // Hidden, the drawer stays mounted so the browser keeps its pages and
        // log, but takes no space, focus or clicks.
        className={hidden ? 'hidden' : undefined}
      >
        {/* 8px in from the drawer's sides and bottom: the tabs standing on the page, Chrome-style, and under them
            one card holding the front tab's body, which the front tab joins. */}
        <div ref={drawerRef} className={cn('relative mx-2 mb-2 flex min-h-0 min-w-0 flex-1 flex-col', leadingTabFlush && 'tray-joined-edge')}>
        <TrayTabs
          tabs={orderedTabs}
          frontKey={front}
          panelId={panelId}
          onLeadingTabFlush={setLeadingTabFlush}
          afterTabs={persistent && (
            <button
              type="button"
              className="inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
              onClick={tray.openNew}
              title="New tab"
              aria-label="New tab"
              data-testid="tray-new-tab"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
          trailing={
            // The drawer's own controls, the same for every tab. Compact layouts
            // already fill their host: they drop full screen and show a close
            // button in place of hide (see globals.css). Where the header has the
            // toggle, the wide hide button here would only repeat it.
            <div className="flex items-center gap-1" data-testid="tray-controls">
              <button
                type="button"
                className="tray-wide-only inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
                onClick={handleToggleExpand}
                title={isExpanded ? 'Exit full screen' : 'Full screen'}
                aria-label={isExpanded ? 'Exit full screen' : 'Full screen'}
                aria-pressed={isExpanded}
                data-testid="tray-fullscreen"
              >
                {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              <button
                type="button"
                className="file-preview-compact-close hidden p-0.5 rounded-icon hover:bg-muted transition-colors"
                onClick={handleHide}
                title="Close panel"
                aria-label="Close panel"
              >
                <X className="h-4 w-4" />
              </button>
              {!headerSlot && (
                <button
                  type="button"
                  className="file-preview-wide-close inline-flex p-0.5 rounded-icon hover:bg-muted transition-colors"
                  onClick={handleHide}
                  title="Hide panel"
                  aria-label="Hide panel"
                  data-testid="tray-hide"
                >
                  <PanelRight className="h-4 w-4" />
                </button>
              )}
            </div>
          }
        />
        <div id={panelId} role="region" aria-label={orderedTabs.find(tab => tab.key === front)?.label} className={TRAY_PANEL_CLASS} data-testid="tray-panel">
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          {/* The browser stays mounted behind other tabs: its stream, its pages
              and its log would otherwise start over on every visit. */}
          {browserActive && (
            <BrowserTrayContent
              agentSlug={agentSlug}
              sessionId={sessionId}
              visible={frontTab?.kind === 'browser'}
              connected={!hidden}
              isExpanded={isExpanded}
              onPagesChange={onPagesChange}
              actionsRef={pageActionsRef}
            />
          )}
          {!hidden && frontTab?.kind === 'file' && (
            <FilePreviewTrayContent sessionId={sessionId} />
          )}
          {!hidden && frontTab?.kind === 'workflow' && (
            <WorkflowTrayContent key={frontTab.key} agentSlug={agentSlug} sessionId={sessionId}
              runId={frontTab.runId} agentId={frontTab.agentId} fallbackName={frontTab.name} />
          )}
          {!hidden && frontTab?.kind === 'new' && (
            <TrayEmptyState launcherKey={frontTab.key} agentSlug={agentSlug} sessionId={sessionId}
              onOpenFile={(path, description) => openFile(path, agentSlug, description)}
              onOpenWorkspace={() => openFolder('/workspace', agentSlug)} />
          )}
          {!hidden && utility && frontTab?.kind === 'utility' && utility.renderPanel(tray, { agentSlug, sessionId }, frontTab.target)}
        </div>
        </div>
        </div>
      </DrawerShell>}
    </>
  )
}
