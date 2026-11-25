// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PresetNumberSelect } from './preset-number-select'

beforeAll(() => {
  // Radix Select scrolls the chosen option into view and tracks the pointer, neither of which jsdom has.
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(cleanup)

function renderSelect(value: number | undefined, onChange = vi.fn()) {
  render(
    <PresetNumberSelect
      id="max-turns"
      label="max turns per session"
      value={value}
      unsetLabel="Unlimited"
      presets={[25, 50, 100]}
      min={1}
      onChange={onChange}
    />,
  )
  return onChange
}

function pick(option: string) {
  fireEvent.click(screen.getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: option }))
}

describe('PresetNumberSelect', () => {
  it('shows what no value means, and no number field', () => {
    renderSelect(undefined)

    expect(screen.getByRole('combobox')).toHaveTextContent('Unlimited')
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('stores a suggested value, and clears it again', () => {
    const onChange = renderSelect(50)
    expect(screen.getByRole('combobox')).toHaveTextContent('50')

    pick('100')
    expect(onChange).toHaveBeenLastCalledWith(100)

    pick('Unlimited')
    expect(onChange).toHaveBeenLastCalledWith(undefined)
  })

  it('opens a number field for Custom and stores what is typed, raised to the minimum', () => {
    const onChange = renderSelect(undefined)

    pick('Custom…')
    expect(onChange).not.toHaveBeenCalled()
    const field = screen.getByRole('spinbutton', { name: 'Custom max turns per session' })

    fireEvent.change(field, { target: { value: '0' } })
    fireEvent.blur(field)
    expect(onChange).toHaveBeenLastCalledWith(1)
    // The field was only for typing: the row goes back to a value and a chevron.
    expect(screen.queryByRole('spinbutton')).toBeNull()
  })

  it('leaves the stored value alone when the custom field is left empty or escaped', () => {
    const onChange = renderSelect(50)

    pick('Custom…')
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '' } })
    fireEvent.blur(screen.getByRole('spinbutton'))
    expect(screen.queryByRole('spinbutton')).toBeNull()

    pick('Custom…')
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '7' } })
    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'Escape' })
    expect(screen.queryByRole('spinbutton')).toBeNull()

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('combobox')).toHaveTextContent('50')
  })

  it('shows a stored value off the list as the row’s value, and lists it among the suggestions', () => {
    renderSelect(75)

    expect(screen.getByRole('combobox')).toHaveTextContent('75')
    expect(screen.queryByRole('spinbutton')).toBeNull()

    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Unlimited', '25', '50', '75', '100', 'Custom…',
    ])
  })

  it('starts the custom field from the stored number', () => {
    renderSelect(75)

    pick('Custom…')
    expect(screen.getByRole('spinbutton')).toHaveValue(75)
  })
})
