// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ShortcutsSection } from './shortcuts-section'

const settings = vi.hoisted(() => ({ shortcut: 'Control+Shift+Space' as string | undefined }))
const mutateAsync = vi.hoisted(() => vi.fn(async () => ({})))
const setGlobalDispatchShortcut = vi.hoisted(() => vi.fn(async () => ({ success: true })))

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: { app: { globalDispatchShortcut: settings.shortcut } } }),
  useUpdateSettings: () => ({ mutateAsync }),
}))
vi.mock('@renderer/lib/env', () => ({ getPlatform: () => 'darwin' }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

beforeEach(() => {
  settings.shortcut = 'Control+Shift+Space'
  mutateAsync.mockClear()
  setGlobalDispatchShortcut.mockClear()
  window.electronAPI = { setGlobalDispatchShortcut } as unknown as typeof window.electronAPI
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

function keys(testId: string): string[] {
  return within(screen.getByTestId(testId)).queryAllByText(/.+/, { selector: 'kbd' }).map((key) => key.textContent ?? '')
}

describe('ShortcutsSection', () => {
  it('says the shortcut in a sentence, one keycap per key, beside the button that changes it', () => {
    render(<ShortcutsSection />)

    expect(screen.getByTestId('dispatch-shortcut-keys')).toHaveTextContent('Press⌃+⇧+Spaceto launch')

    expect(keys('dispatch-shortcut-keys')).toEqual(['⌃', '⇧', 'Space'])
    expect(screen.getByRole('button', { name: 'Customize' })).toBeTruthy()
    expect(screen.queryByTestId('dispatch-shortcut-recording')).toBeNull()
  })

  it('offers Reset to default in the popover, only when the shortcut is not the default', async () => {
    render(<ShortcutsSection />)
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    expect(screen.queryByRole('button', { name: 'Reset to default' })).toBeNull()
    cleanup()

    settings.shortcut = 'Control+Alt+K'
    render(<ShortcutsSection />)
    expect(keys('dispatch-shortcut-keys')).toEqual(['⌃', '⌥', 'K'])

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(setGlobalDispatchShortcut).toHaveBeenCalledWith('Control+Shift+Space'))
    expect(screen.queryByTestId('dispatch-shortcut-recording')).toBeNull()
  })

  it('listens in a popover after Customize, echoes the modifiers held, and stores the combination pressed', async () => {
    render(<ShortcutsSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    const field = screen.getByTestId('dispatch-shortcut-recording')
    expect(field).toHaveTextContent('Waiting for keys…')

    act(() => { fireEvent.keyDown(window, { key: 'Control', code: 'ControlLeft', ctrlKey: true }) })
    expect(keys('dispatch-shortcut-recording')).toEqual(['⌃'])
    expect(field).toHaveTextContent('then a key…')

    act(() => { fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true, altKey: true }) })
    await waitFor(() => expect(setGlobalDispatchShortcut).toHaveBeenCalledWith('Control+Alt+K'))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ app: { globalDispatchShortcut: 'Control+Alt+K' } }))
    expect(screen.queryByTestId('dispatch-shortcut-recording')).toBeNull()
  })

  it('stops listening on Escape or Cancel without storing anything', () => {
    render(<ShortcutsSection />)

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    act(() => { fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' }) })
    expect(screen.queryByTestId('dispatch-shortcut-recording')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('dispatch-shortcut-recording')).toBeNull()
    expect(setGlobalDispatchShortcut).not.toHaveBeenCalled()
  })

  it('shows no shortcut row while the launcher is off', () => {
    settings.shortcut = ''
    render(<ShortcutsSection />)

    expect(screen.queryByTestId('dispatch-shortcut-keys')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enable Quick Dispatch launcher' })).toHaveAttribute('aria-checked', 'false')
  })
})
