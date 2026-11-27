import { describe, it, expect } from 'vitest'
import { validatePressKey } from './press-key'

describe('validatePressKey', () => {
  it('accepts single printable characters', () => {
    expect(validatePressKey('a')).toBeNull()
    expect(validatePressKey('5')).toBeNull()
    expect(validatePressKey('%')).toBeNull()
    expect(validatePressKey('+')).toBeNull()
  })

  it('accepts named keys case-insensitively', () => {
    expect(validatePressKey('Enter')).toBeNull()
    expect(validatePressKey('Tab')).toBeNull()
    expect(validatePressKey('Escape')).toBeNull()
    expect(validatePressKey('ArrowDown')).toBeNull()
    expect(validatePressKey('arrowdown')).toBeNull()
    expect(validatePressKey('Backspace')).toBeNull()
    expect(validatePressKey('PageDown')).toBeNull()
    expect(validatePressKey('F5')).toBeNull()
  })

  it('accepts CDP key codes', () => {
    expect(validatePressKey('KeyA')).toBeNull()
    expect(validatePressKey('Digit5')).toBeNull()
    expect(validatePressKey('Numpad3')).toBeNull()
  })

  it('accepts modifier combos', () => {
    expect(validatePressKey('Control+a')).toBeNull()
    expect(validatePressKey('Control+Shift+K')).toBeNull()
    expect(validatePressKey('Meta+v')).toBeNull()
    expect(validatePressKey('ctrl+Enter')).toBeNull()
    expect(validatePressKey('Shift+Tab')).toBeNull()
    expect(validatePressKey('Control++')).toBeNull()
  })

  it('rejects multi-character text (the digit-by-digit card entry trigger)', () => {
    const err = validatePressKey('4242424242424242')
    expect(err).toMatch(/cannot type text/)
    expect(err).toMatch(/browser_type/)
    expect(validatePressKey('hello world')).not.toBeNull()
    expect(validatePressKey('isn')).not.toBeNull()
  })

  it('rejects combos with non-modifier prefixes or invalid final keys', () => {
    expect(validatePressKey('Enter+a')).not.toBeNull()
    expect(validatePressKey('Control+hello')).not.toBeNull()
  })

  it('takes the modifier names the CLI reads, and names the right one for an alias it does not', () => {
    // 0.45 interaction.rs key_modifier_bit: alt, ctrl/control, meta/cmd/command, shift (and Left/Right).
    for (const combo of ['Alt+a', 'Ctrl+a', 'Meta+k', 'Cmd+Shift+z', 'Command+c', 'ShiftLeft+Tab', 'ControlRight+End']) {
      expect(validatePressKey(combo), combo).toBeNull()
    }
    // "Option+a" would be pressed as one key named "Option+a", which types nothing.
    expect(validatePressKey('Option+a')).toBe('"Option" is not a modifier name the browser reads; it is "Alt" there: press "Alt+a".')
    expect(validatePressKey('Super+Shift+k')).toBe('"Super" is not a modifier name the browser reads; it is "Meta" there: press "Meta+Shift+k".')
    expect(validatePressKey('Shift+Option+ArrowLeft')).toContain('press "Shift+Alt+ArrowLeft"')
  })

  it('rejects empty input', () => {
    expect(validatePressKey('')).not.toBeNull()
    expect(validatePressKey('  ')).not.toBeNull()
  })
})
