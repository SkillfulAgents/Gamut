import type { BrowserTabInfo } from '@shared/lib/browser-stream-protocol'
import type { FileComment, PreviewTab } from '@renderer/context/file-preview-context'
import { getPreviewTabKey } from '@renderer/lib/preview-tab-key'
import type { RegisteredResident, TrayUtilityTargets, UtilityId } from './tray-resident'

type BrowserEntry = { kind: 'browser'; key: string; page?: BrowserTabInfo }
export type TrayEntry =
  | BrowserEntry
  | { kind: 'file'; key: string; file: PreviewTab }
  | { kind: 'workflow'; key: string; runId: string; name?: string; agentId?: string }
  | { kind: 'utility'; key: string; id: UtilityId; target: unknown }
  | { kind: 'new'; key: string }

export interface TrayState {
  tabs: TrayEntry[]
  selected: string | null
  hidden: boolean
  comments: Map<string, FileComment[]>
}

const placeholder: BrowserEntry = { kind: 'browser', key: 'browser:pending' }

/** A removed tab gives focus to its next surviving neighbour, then its previous one. */
function selectionAfterRemoval(before: TrayEntry[], after: TrayEntry[], selected: string | null) {
  const keys = new Set(after.map(tab => tab.key))
  if (selected && keys.has(selected)) return selected
  const index = before.findIndex(tab => tab.key === selected)
  return before.slice(index + 1).find(tab => keys.has(tab.key))?.key
    ?? before.slice(0, Math.max(0, index)).reverse().find(tab => keys.has(tab.key))?.key
    ?? after[0]?.key ?? null
}

/** One renderer-owned navigation history. All residents submit their changes here. */
export class SessionTray {
  private state: TrayState = { tabs: [], selected: null, hidden: false, comments: new Map() }
  private listeners = new Set<() => void>()
  constructor(private readonly residents: readonly RegisteredResident[] = []) {}
  private seq = 0
  private launcherKey: string | null = null
  private viewedBrowserPage: string | null = null
  snapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(change: Partial<TrayState>) {
    this.state = { ...this.state, ...change }
    this.listeners.forEach(listener => listener())
  }
  private open(tab: TrayEntry) {
    const { tabs } = this.state
    const old = tabs.find(item => item.key === tab.key)
    const launcher = tabs.find(item => item.key === this.launcherKey && item.kind === 'new')
    let next = tabs
    if (old) next = tabs.map(item => item === old ? tab : item)
    else if (launcher && tab.kind !== 'new') next = tabs.map(item => item === launcher ? tab : item)
    else next = [...tabs, tab]
    if (old && launcher && tab.kind !== 'new') next = next.filter(item => item !== launcher)
    this.update({ tabs: next, selected: tab.key, hidden: false })
  }
  /** A choice made inside a launcher consumes that launcher. Opening from chat leaves it in the strip. */
  pickFromLauncher = (key: string, open: () => void) => {
    this.launcherKey = key
    try { open() } finally { this.launcherKey = null }
  }
  select = (key: string) => {
    if (this.state.tabs.some(tab => tab.key === key)) this.update({ selected: key, hidden: false })
  }
  close = (key: string) => {
    const before = this.state.tabs
    const next = before.filter(tab => tab.key !== key)
    if (next.length === before.length) return
    this.update({ tabs: next, selected: selectionAfterRemoval(before, next, this.state.selected), hidden: next.length > 0 && this.state.hidden })
  }
  hide = () => this.update({ hidden: true })
  show = () => this.state.tabs.length ? this.update({ hidden: false }) : this.openNew()
  openNew = () => this.open({ kind: 'new', key: `new:${++this.seq}` })
  openUtility = <K extends UtilityId>(id: K, target?: TrayUtilityTargets[K]) => {
    const resident = this.residents.find(entry => entry.id === id)
    const resourceKey = resident?.keyFor?.(target ?? null)
    const key = resourceKey === undefined ? `utility:${id}` : `utility:${id}:${resourceKey}`
    const previous = this.state.tabs.find(tab => tab.key === key)
    this.open({ kind: 'utility', id, key, target: target === undefined && previous?.kind === 'utility' ? previous.target : target ?? null })
  }
  openWorkflow = (runId: string, name?: string) => {
    const key = `workflow:${runId}`
    const old = this.state.tabs.find(tab => tab.key === key)
    this.open({ kind: 'workflow', key, runId, name: name ?? (old?.kind === 'workflow' ? old.name : undefined) })
  }
  viewWorkflowAgent = (runId: string, agentId: string | null) => {
    this.update({ tabs: this.state.tabs.map(tab => tab.kind === 'workflow' && tab.runId === runId ? { ...tab, agentId: agentId ?? undefined } : tab) })
  }
  openFileTab = (file: PreviewTab, refresh?: (old: PreviewTab) => PreviewTab) => {
    const key = getPreviewTabKey(file)
    const old = this.state.tabs.find(tab => tab.key === key)
    this.open({ kind: 'file', key, file: old?.kind === 'file' ? refresh?.(old.file) ?? old.file : file })
  }
  /** Edits and path changes retain the file's position among other residents. */
  mapFiles = (transform: (file: PreviewTab) => PreviewTab | null) => {
    const before = this.state.tabs
    const next: TrayEntry[] = []
    let selected = this.state.selected
    let changed = false
    for (const tab of before) {
      if (tab.kind !== 'file') { next.push(tab); continue }
      const file = transform(tab.file)
      if (file === tab.file) { next.push(tab); continue }
      changed = true
      if (!file) continue
      const key = getPreviewTabKey(file)
      if (selected === tab.key) selected = key
      next.push({ kind: 'file', key, file })
    }
    if (changed) this.update({ tabs: next, selected: selectionAfterRemoval(before, next, selected), hidden: next.length > 0 && this.state.hidden })
  }
  setComments = (transform: (old: Map<string, FileComment[]>) => Map<string, FileComment[]>) => {
    const comments = transform(this.state.comments)
    if (comments !== this.state.comments) this.update({ comments })
  }
  browserAvailable = (available: boolean | null) => {
    if (available === null) return
    if (!available) {
      this.viewedBrowserPage = null
      this.replaceBrowserPages([])
    } else if (!this.state.tabs.some(tab => tab.kind === 'browser')) {
      this.replaceBrowserPages([placeholder])
    }
  }
  syncBrowser = (pages: BrowserTabInfo[], viewingTargetId: string | null) => {
    if (!pages.length) return
    const next: BrowserEntry[] = pages.map(page => ({ kind: 'browser', key: `browser:${page.targetId}`, page }))
    const viewed = viewingTargetId ?? pages.find(page => page.active)?.targetId ?? pages[0].targetId
    const follows = this.viewedBrowserPage !== viewed
    this.viewedBrowserPage = viewed
    this.replaceBrowserPages(next, follows ? `browser:${viewed}` : undefined)
  }
  private replaceBrowserPages(pages: BrowserEntry[], followed?: string) {
    const { tabs, selected, hidden } = this.state
    if (!pages.length && !tabs.some(tab => tab.kind === 'browser')) return
    const byKey = new Map(pages.map(tab => [tab.key, tab]))
    const newPages = pages.filter(page => !tabs.some(tab => tab.key === page.key))
    const next: TrayEntry[] = []
    let replacedPlaceholder = false
    for (const tab of tabs) {
      if (tab.kind !== 'browser') next.push(tab)
      else if (byKey.has(tab.key)) next.push(byKey.get(tab.key)!)
      else if (tab.key === placeholder.key) {
        next.push(...newPages)
        replacedPlaceholder = true
      }
    }
    if (!replacedPlaceholder) next.push(...newPages)
    const frontWasBrowser = tabs.some(tab => tab.key === selected && tab.kind === 'browser')
    const front = frontWasBrowser && (selected === placeholder.key || byKey.has(selected!)) && followed && byKey.has(followed) ? followed : selectionAfterRemoval(tabs, next, selected)
    this.update({ tabs: next, selected: front, hidden: next.length > 0 && hidden })
  }
}
