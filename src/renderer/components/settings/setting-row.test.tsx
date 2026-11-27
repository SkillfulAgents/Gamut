// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingRow } from './setting-row'

afterEach(cleanup)

describe('SettingRow', () => {
  it('is a label and its control, with no second line and no help icon by default', () => {
    render(<SettingRow name="Share Error Reports" htmlFor="reports" right={<input id="reports" type="checkbox" />} />)

    expect(screen.getByLabelText('Share Error Reports')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('puts what the label cannot carry behind a help icon that does not act on the control', () => {
    const onChange = vi.fn()
    render(
      <SettingRow
        name="Auto-Delete Inactive Sessions"
        help="Starred sessions are never deleted."
        htmlFor="auto-delete"
        right={<input id="auto-delete" type="checkbox" onChange={onChange} />}
      />,
    )

    expect(screen.queryByText('Starred sessions are never deleted.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'About Auto-Delete Inactive Sessions' }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('opens the help from the label as well as from the icon', async () => {
    render(<SettingRow name="Keep Awake" help="Stops your Mac from sleeping." right={null} />)

    const icon = screen.getByRole('button', { name: 'About Keep Awake' })
    const trigger = icon.parentElement!
    expect(trigger.contains(screen.getByText('Keep Awake'))).toBe(true)

    fireEvent.focus(icon)
    expect((await screen.findAllByText('Stops your Mac from sleeping.')).length).toBeGreaterThan(0)
  })

  it('shows live status and whatever the row adds underneath', () => {
    render(
      <SettingRow name="Software Updates" status="Version 1.2.3 is available" right={null}>
        <p>Restart to finish</p>
      </SettingRow>,
    )

    expect(screen.getByText('Version 1.2.3 is available')).toBeTruthy()
    expect(screen.getByText('Restart to finish')).toBeTruthy()
  })
})
