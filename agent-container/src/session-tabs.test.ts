import { describe, expect, it } from 'vitest'
import type { TabInfo } from './tab-manager'
import { closesTabs, labelTabList, ownTabCount, popupsOf, tabAfterClose, tabCloses, type TabsAsSeen } from './session-tabs'

const tab = (tabId: string, active = false, url = `https://site.example/${tabId}`): TabInfo =>
  ({ tabId, targetId: `T-${tabId}`, label: null, url, title: tabId, active })

/** Session A's view: it opened t1 and t4, another session opened t2 and t3 and is on t3. */
function seen(tabs: TabInfo[]): TabsAsSeen {
  const mine = new Set(['T-t1', 'T-t4'])
  const theirs = new Set(['T-t2', 'T-t3'])
  return {
    tabs,
    openedBy: (id) => (mine.has(id) ? 'this' : theirs.has(id) ? 'another' : null),
    inUseByAnother: (id) => id === 'T-t3',
  }
}

describe('labelTabList', () => {
  it('marks who opened each tab and whether another session is on it, and leaves the rest of the list as the CLI printed it', () => {
    const output = [
      '→ [t1] One - https://site.example/t1',
      '  [t2] Two - https://site.example/t2',
      '  [t3] Three - https://site.example/t3',
      '  [t5] Five - https://site.example/t5',
    ].join('\n')
    const tabs = [tab('t1', true), tab('t2'), tab('t3'), tab('t5')]
    expect(labelTabList(output, seen(tabs))).toBe([
      '→ [t1] One - https://site.example/t1 (opened by this session)',
      '  [t2] Two - https://site.example/t2 (opened by another session)',
      '  [t3] Three - https://site.example/t3 (opened by another session; another session is on it now)',
      '  [t5] Five - https://site.example/t5',
    ].join('\n'))
  })

  it('leaves a line alone when its tab id is not in the session\'s list', () => {
    expect(labelTabList('  [t9] Gone - https://x.example/', seen([tab('t1', true)]))).toBe('  [t9] Gone - https://x.example/')
  })
})

describe('tabCloses', () => {
  const tabs = [tab('t1'), tab('t2'), tab('t3'), tab('t4', true)]

  it('refuses the tab another session is on, by id, label or target id, also inside a batch', () => {
    expect(tabCloses([['tab', 'close', 't3']], seen(tabs)).refusal).toBe('Tab t3 was not closed: another session is on it now.')
    expect(tabCloses([['tab', 'close', 'T-t3']], seen(tabs)).refusal).toMatch(/not closed/)
    expect(tabCloses([['get', 'url'], ['tab', 'close', 't3']], seen(tabs)).refusal).toMatch(/not closed/)
  })

  it('lets the session close any other tab, another session\'s included', () => {
    expect(tabCloses([['tab', 'close', 't2']], seen(tabs))).toEqual({ refusal: null, closesOwnTabAt: null })
  })

  it('says where the session\'s own tab is when a close takes it, by ref or with none', () => {
    expect(tabCloses([['tab', 'close']], seen(tabs))).toEqual({ refusal: null, closesOwnTabAt: 3 })
    expect(tabCloses([['tab', 'close', 't4']], seen(tabs))).toEqual({ refusal: null, closesOwnTabAt: 3 })
  })
})

describe('closesTabs', () => {
  it('finds a `tab close` among a run\'s commands', () => {
    expect(closesTabs([['open', 'x'], ['TAB', 'Close', 't2']])).toBe(true)
    expect(closesTabs([['tab', 'new'], ['tab']])).toBe(false)
  })
})

describe('ownTabCount', () => {
  it('counts the tabs the session opened and the one it is on, not other sessions\' tabs', () => {
    const tabs = [tab('t1'), tab('t2', true), tab('t3'), tab('t4')]
    expect(ownTabCount(tabs, new Set(['T-t1', 'T-t4']))).toBe(3)
    expect(ownTabCount(tabs, new Set())).toBe(1)
  })
})

describe('tabAfterClose', () => {
  it('moves to the own tab that took the closed one\'s place, else the last own tab', () => {
    // A closed its tab at index 1; t4 (its own) slid in after another session's t2 and t3.
    expect(tabAfterClose(seen([tab('t1'), tab('t2'), tab('t3'), tab('t4')]), 1)).toBe('T-t4')
    expect(tabAfterClose(seen([tab('t1'), tab('t2'), tab('t3')]), 3)).toBe('T-t1')
  })

  it('takes another session\'s idle tab when it has none of its own left, never the tab another session is on', () => {
    expect(tabAfterClose(seen([tab('t2'), tab('t3')]), 0)).toBe('T-t2')
    expect(tabAfterClose(seen([tab('t3')]), 0)).toBeNull()
  })

  it('does nothing when the session is on a tab already', () => {
    expect(tabAfterClose(seen([tab('t1', true), tab('t4')]), 0)).toBeNull()
  })
})

describe('popupsOf', () => {
  const fresh = [tab('t6'), tab('t7'), tab('t8')]
  const openers = new Map([['T-t6', 'T-t4'], ['T-t7', 'T-t3'], ['T-t8', 'T-t1']])

  it('takes the pages opened from the tab the session is on, or from one it opened', () => {
    expect(popupsOf(fresh, 'T-t4', new Set(['T-t1']), openers).map(t => t.tabId)).toEqual(['t6', 't8'])
  })

  it('leaves pages opened from another session\'s tab, and tabs with no opener (`tab new`, the user)', () => {
    expect(popupsOf([tab('t7'), tab('t9')], 'T-t4', new Set(), openers)).toEqual([])
  })
})
