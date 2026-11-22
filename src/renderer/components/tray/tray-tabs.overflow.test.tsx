// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TrayTabs, shownTabs, type TrayTab } from './tray-tabs'

function setStripWidth(width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'tray-tab-group' ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'tray-tab-group' ? width : 0
  })
  HTMLElement.prototype.scrollTo = vi.fn() as HTMLElement['scrollTo']
}

const tab = (key: string, label: string, onSelect: () => void = vi.fn(), onClose?: () => void): TrayTab => ({ key, kind: 'file', label, icon: null, onSelect, onClose })

describe('TrayTabs overflow', () => {
  it('keeps the front tab on show when only some fit', () => {
    expect(shownTabs(['a', 'b', 'c', 'd'].map(key => ({ key })), 3, 2).map(t => t.key)).toEqual(['a', 'd'])
    expect(shownTabs(['a', 'b', 'c'].map(key => ({ key })), 1, 2).map(t => t.key)).toEqual(['a', 'b'])
    expect(shownTabs(['a', 'b'].map(key => ({ key })), 0, 5).map(t => t.key)).toEqual(['a', 'b'])
  })

  afterEach(() => vi.restoreAllMocks())

  it('shows neither arrows nor the tab list while every tab fits', () => {
    setStripWidth(600)
    render(<TrayTabs tabs={[tab('a', 'Alpha'), tab('b', 'Beta')]} frontKey="a" />)
    expect(screen.queryByTestId('tray-tab-all')).toBeNull()
    expect(screen.queryByTestId('tray-tab-arrows')).toBeNull()
  })

  it.each([[248, 1], [249, 2], [333, 2], [334, 3], [419, 4]])('fits the selected tab and its peers in a %ipx strip', (width, count) => {
    setStripWidth(width)
    const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']
    render(<TrayTabs tabs={names.map(name => tab(name, name))} frontKey="Epsilon" />)
    expect(screen.getAllByTestId('file-tab').map(t => t.textContent)).toEqual([...names.slice(0, count - 1), 'Epsilon'])
    expect(screen.getByTestId('tray-tab-hidden-count')).toHaveTextContent(String(names.length - count))
  })

  it('announces the selected tab and moves keyboard focus to peers in overflow', async () => {
    setStripWidth(200)
    function Navigation() {
      const [front, select] = useState('Alpha')
      return <TrayTabs tabs={['Alpha', 'Beta', 'Gamma'].map(label => tab(label, label, () => select(label)))} frontKey={front} />
    }
    render(<Navigation />)
    const user = userEvent.setup()
    const group = within(screen.getByRole('group', { name: 'Tray tabs' }))
    group.getByRole('button', { name: 'Alpha', pressed: true }).focus()
    await user.keyboard('{ArrowRight}')
    expect(group.getByRole('button', { name: 'Beta', pressed: true })).toHaveFocus()
    await user.keyboard('{End}')
    expect(group.getByRole('button', { name: 'Gamma', pressed: true })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(group.getByRole('button', { name: 'Alpha', pressed: true })).toHaveFocus()
    await user.keyboard('{ArrowLeft}{Home}')
    expect(group.getByRole('button', { name: 'Alpha', pressed: true })).toHaveFocus()
  })

  it('swaps the scroll arrows for a chevron that lists every tab and picks one', async () => {
    setStripWidth(200)
    const pickGamma = vi.fn()
    const user = userEvent.setup()
    render(<TrayTabs tabs={[tab('a', 'Alpha'), tab('b', 'Beta'), tab('c', 'Gamma', pickGamma)]} frontKey="b" />)
    expect(screen.queryByTestId('tray-tab-arrows')).toBeNull()
    // Room for one: the front tab stays on show, and the rest are only in the list.
    expect(screen.getAllByTestId('file-tab').map(t => t.textContent)).toEqual(['Beta'])
    expect(screen.getByTestId('tray-tab-hidden-count')).toHaveTextContent('2')
    await user.click(screen.getByTestId('tray-tab-all'))
    const items = await screen.findAllByTestId('tray-tab-all-item')
    expect(items.map(item => item.textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(items[1]).toHaveAttribute('data-active', 'true')
    await user.click(items[2])
    expect(pickGamma).toHaveBeenCalled()
  })

  it('closes a tab from the list without selecting it, and keeps the list open', async () => {
    setStripWidth(200)
    const pickAlpha = vi.fn()
    const closeAlpha = vi.fn()
    const user = userEvent.setup()
    render(<TrayTabs tabs={[tab('a', 'Alpha', pickAlpha, closeAlpha), tab('b', 'Beta'), tab('c', 'Gamma')]} frontKey="b" />)
    await user.click(screen.getByTestId('tray-tab-all'))
    const menu = await screen.findByTestId('tray-tab-all-menu')
    await user.click(within(menu).getByRole('button', { name: 'Close Alpha' }))
    expect(closeAlpha).toHaveBeenCalled()
    expect(pickAlpha).not.toHaveBeenCalled()
    expect(screen.getByTestId('tray-tab-all-menu')).toBeInTheDocument()
  })
})
