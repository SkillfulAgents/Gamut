// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Moon, Sun } from 'lucide-react'
import { SegmentedControl } from './segmented-control'

afterEach(cleanup)

describe('SegmentedControl', () => {
  it('is one choice among its segments, with the chosen one checked', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        aria-label="Notifications"
        value="on"
        options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        onChange={onChange}
      />,
    )

    expect(screen.getByRole('radiogroup', { name: 'Notifications' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'On' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(onChange).toHaveBeenCalledWith('off')
  })

  it('names an icon segment, which shows no text of its own', () => {
    render(
      <SegmentedControl
        aria-label="Appearance"
        value="light"
        options={[
          { value: 'light', label: 'Light', icon: Sun, ariaLabel: 'Light theme' },
          { value: 'dark', label: 'Dark', icon: Moon },
        ]}
        onChange={() => {}}
      />,
    )

    expect(screen.getByRole('radio', { name: 'Light theme' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeTruthy()
    expect(screen.queryByText('Light')).toBeNull()
  })

  it('takes no clicks while disabled', () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        aria-label="Notifications"
        value="on"
        options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        onChange={onChange}
        disabled
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
