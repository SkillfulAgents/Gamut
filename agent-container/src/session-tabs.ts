import type { TabInfo } from './tab-manager'

/**
 * How one session sees the tabs of the agent's browser, which all of its
 * sessions share. A tab belongs to the agent; what a session knows of the
 * others is who opened a tab and whether another session is on it now (its
 * agent-browser instance holds that tab). server.ts reads those facts; these
 * decide what they mean for the session's tab commands.
 */
export interface TabsAsSeen {
  /** The session's instance's tab list: every tab, its own marked active. */
  tabs: TabInfo[]
  /** Who opened a tab, by CDP target id: this session, another one, or none we know of. */
  openedBy(targetId: string): 'this' | 'another' | null
  /** Whether another session is on the tab now. */
  inUseByAnother(targetId: string): boolean
}

/** The CLI's tab list (`[t3] Title - url` lines) with each tab marked by who opened it and whether another session is on it now. */
export function labelTabList(output: string, seen: TabsAsSeen): string {
  const targets = new Map(seen.tabs.map(t => [t.tabId, t.targetId]))
  return output.split('\n').map((line) => {
    const targetId = targets.get(/\[(t\d+)\]/.exec(line)?.[1] ?? '')
    if (!targetId) return line
    const opener = seen.openedBy(targetId)
    const notes = [
      ...(opener ? [opener === 'this' ? 'opened by this session' : 'opened by another session'] : []),
      ...(seen.inUseByAnother(targetId) ? ['another session is on it now'] : []),
    ]
    return notes.length ? `${line} (${notes.join('; ')})` : line
  }).join('\n')
}

/**
 * What a run's `tab close` commands do here. Every tab is the session's to
 * close but the one another session is on now: closing it would leave that
 * session with no tab mid-task (agent-browser refuses only a switch to it,
 * with `tab_locked`). `closesOwnTabAt` is where the session's own tab is in
 * its list when one of them closes it.
 */
export function tabCloses(commands: string[][], seen: TabsAsSeen): { refusal: string | null; closesOwnTabAt: number | null } {
  let closesOwnTabAt: number | null = null
  for (const command of commands) {
    if (!closesTabs([command])) continue
    const ref = command[2]
    const index = ref
      ? seen.tabs.findIndex(t => t.tabId === ref || t.label === ref || t.targetId === ref)
      : seen.tabs.findIndex(t => t.active)
    const tab = seen.tabs[index]
    if (ref && tab?.targetId && seen.inUseByAnother(tab.targetId)) {
      return { refusal: `Tab ${ref} was not closed: another session is on it now.`, closesOwnTabAt: null }
    }
    if (tab?.active) closesOwnTabAt = index
  }
  return { refusal: null, closesOwnTabAt }
}

/**
 * Where a session goes once it closed its own tab. Unpinned, agent-browser
 * moved to the tab that took the closed one's place, or to the last one; a
 * pinned instance is left on no tab. The same choice, among the tabs the
 * session opened first, and never a tab another session is on. Null when no
 * tab is left to go to, or the session is on one already.
 */
export function tabAfterClose(seen: TabsAsSeen, closedAt: number): string | null {
  if (seen.tabs.some(t => t.active)) return null
  const free = seen.tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => tab.targetId && !seen.inUseByAnother(tab.targetId))
  const own = free.filter(({ tab }) => seen.openedBy(tab.targetId!) === 'this')
  const among = own.length > 0 ? own : free
  return (among.find(({ index }) => index >= closedAt) ?? among[among.length - 1])?.tab.targetId ?? null
}

/**
 * How many tabs a session has, for its tab count and tab-limit warnings: the
 * ones it opened and the one it is on. Other sessions' tabs are theirs to
 * close, so they are not counted against this one.
 */
export function ownTabCount(tabs: TabInfo[], opened: ReadonlySet<string>): number {
  return tabs.filter(t => t.active || (t.targetId !== undefined && opened.has(t.targetId))).length
}

/** Whether a run's commands close tabs (`tab close`). */
export function closesTabs(commands: string[][]): boolean {
  return commands.some(command => command[0]?.toLowerCase() === 'tab' && command[1]?.toLowerCase() === 'close')
}

/**
 * Of the tabs new to a session since it last looked, the pages its own tabs
 * opened (a target="_blank" link, window.open): their opener is the tab it is
 * on, or one it opened. `openers` maps a page's CDP target id to its opener's.
 * Tabs another session opened, or the user did, are not among them.
 */
export function popupsOf(fresh: TabInfo[], current: string | undefined, opened: ReadonlySet<string>, openers: ReadonlyMap<string, string>): TabInfo[] {
  return fresh.filter((tab) => {
    const opener = tab.targetId ? openers.get(tab.targetId) : undefined
    return opener !== undefined && (opener === current || opened.has(opener))
  })
}
