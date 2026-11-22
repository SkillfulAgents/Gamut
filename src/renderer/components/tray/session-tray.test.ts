import { describe, expect, it } from 'vitest'
import { defineTrayResident } from './tray-resident'
import { SessionTray } from './session-tray'
import type { FileTab } from '@renderer/context/file-preview-context'

function file(name: string): FileTab {
  return { kind: 'file', agentSlug: 'a', filePath: '/workspace/' + name, displayName: name, pdfPage: 1, version: 1 }
}
const page = { targetId: 'p', title: 'First page', active: true, index: 0, url: 'about:blank' }

declare module './tray-resident' {
  interface TrayUtilityTargets {
    collectionFixture: string | null
    resourceFixture: string | null
  }
}

describe('session tray navigation', () => {
  it('selects the next mixed tab when a file is closed, retaining subsequent files', () => {
    const tray = new SessionTray()
    tray.openFileTab(file('first.md'))
    const first = tray.snapshot().selected!
    tray.browserAvailable(true)
    tray.syncBrowser([page], 'p')
    tray.openFileTab(file('second.md'))
    tray.select(first)
    tray.close(first)
    expect(tray.snapshot().tabs.map(tab => tab.kind)).toEqual(['browser', 'file'])
    expect(tray.snapshot().selected).toBe('browser:p')
  })

  it('keeps a file selected through browser follow, reconnect and repeated opens', () => {
    const tray = new SessionTray()
    tray.browserAvailable(true)
    tray.openFileTab(file('notes.pdf'))
    const { selected } = tray.snapshot()
    tray.hide()
    tray.syncBrowser([page, { ...page, targetId: 'q', index: 1 }], 'q')
    expect(tray.snapshot()).toMatchObject({ selected, hidden: true })
    tray.openFileTab(file('notes.pdf'))
    expect(tray.snapshot()).toMatchObject({ selected, hidden: false })
    expect(tray.snapshot().tabs).toHaveLength(3)
  })

  it('replaces a launcher in place and remembers the selection through renames', () => {
    const tray = new SessionTray()
    tray.openNew()
    const newKey = tray.snapshot().selected!
    tray.openNew()
    tray.select(newKey)
    tray.pickFromLauncher(newKey, () => tray.openFileTab(file('a.md')))
    tray.mapFiles(() => file('b.md'))
    const { tabs, selected } = tray.snapshot()
    expect(tabs.map(tab => tab.kind)).toEqual(['file', 'new'])
    expect(selected).toBe(tabs[0].key)
  })

  it('preserves a launcher when opening from chat and keeps the mixed order through status hydration', () => {
    const tray = new SessionTray()
    tray.browserAvailable(true)
    tray.syncBrowser([page], 'p')
    tray.openFileTab(file('notes.md'))
    const notes = tray.snapshot().selected!
    tray.openNew()
    const launcher = tray.snapshot().selected!
    tray.openFileTab(file('notes.md'))
    tray.browserAvailable(null)
    tray.browserAvailable(true)
    tray.syncBrowser([page], 'p')
    tray.close(notes)
    expect(tray.snapshot().selected).toBe(launcher)
    expect(tray.snapshot().tabs.map(tab => tab.kind)).toEqual(['browser', 'new'])
  })

  it('lets a resident group its details or give each resource a peer tab', () => {
    const components = { Icon: () => null, Panel: () => null }
    const grouped = defineTrayResident({ id: 'collectionFixture', label: 'All', ...components })
    const multiple = defineTrayResident({ id: 'resourceFixture', label: 'Resources',
      keyFor: item => item ?? 'list', titleFor: item => item ?? 'All resources', ...components })
    const tray = new SessionTray([grouped, multiple])
    tray.openUtility('collectionFixture', 'a')
    tray.openUtility('collectionFixture', 'b')
    tray.openUtility('resourceFixture', 'p')
    tray.openUtility('resourceFixture', 'q')
    tray.openUtility('resourceFixture', 'p')
    const { tabs, selected } = tray.snapshot()
    expect(tabs).toHaveLength(3)
    expect(tabs[0]).toMatchObject({ target: 'b' })
    expect(tabs[1]).toMatchObject({ key: selected, target: 'p' })
    expect(multiple.titleFor?.('q')).toBe('q')
  })
})
