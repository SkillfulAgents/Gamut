// @vitest-environment jsdom
import { memo } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.unmock('@renderer/context/search-context')

import { SearchProvider, useSearch, useSearchOpen } from './search-context'

const counts = { opener: 0, reader: 0 }
const seenActions = new Set<unknown>()

// What the sidebar and Home do: take `openSearch` for a button.
const Opener = memo(function Opener() {
  counts.opener++
  const actions = useSearch()
  seenActions.add(actions)
  return (
    <>
      <button onClick={actions.openSearch}>open search</button>
      <button onClick={actions.closeSearch}>close search</button>
    </>
  )
})

// What the dialog does: read whether it is open.
const Reader = memo(function Reader() {
  counts.reader++
  return <span data-testid="state">{useSearchOpen() ? 'open' : 'closed'}</span>
})

function setup() {
  counts.opener = 0
  counts.reader = 0
  seenActions.clear()
  render(<SearchProvider><Opener /><Reader /></SearchProvider>)
}

const state = () => screen.getByTestId('state').textContent

describe('SearchProvider', () => {
  it('renders only readers of the open state when search opens and closes', () => {
    setup()
    expect(counts).toEqual({ opener: 1, reader: 1 })

    fireEvent.click(screen.getByText('open search'))
    expect(state()).toBe('open')
    fireEvent.click(screen.getByText('close search'))
    expect(state()).toBe('closed')
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(state()).toBe('open')
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(state()).toBe('closed')

    // Four changes of state: four renders of the reader, none of the opener,
    // which was handed one actions object for all of them.
    expect(counts).toEqual({ opener: 1, reader: 5 })
    expect(seenActions.size).toBe(1)
  })

  it('toggles on cmd/ctrl-K in either case, and on nothing else', () => {
    setup()
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      act(() => { window.dispatchEvent(event) })
      return event.defaultPrevented
    }

    expect(press({ key: 'K', metaKey: true })).toBe(true)
    expect(state()).toBe('open')
    expect(press({ key: 'k' })).toBe(false)
    expect(press({ key: 'j', metaKey: true })).toBe(false)
    expect(state()).toBe('open')
    expect(press({ key: 'k', ctrlKey: true })).toBe(true)
    expect(state()).toBe('closed')
  })

  it('does not render again when asked for the state it is already in', () => {
    setup()
    fireEvent.click(screen.getByText('close search'))
    expect(counts.reader).toBe(1)
    fireEvent.click(screen.getByText('open search'))
    fireEvent.click(screen.getByText('open search'))
    expect(counts.reader).toBe(2)
  })

  it('throws outside a provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Opener />)).toThrow('useSearch must be used within a SearchProvider')
    expect(() => render(<Reader />)).toThrow('useSearchOpen must be used within a SearchProvider')
    quiet.mockRestore()
  })
})
