// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDictationShortcut, registerDictationTarget, type DictationTarget } from './dictation-shortcut'

const cleanups: Array<() => void> = []

/** A mic button in a form of its own, with a text field beside it. */
function mic(options: { active?: boolean; canStart?: boolean; within?: HTMLElement } = {}) {
  const form = document.createElement('form')
  const field = document.createElement('textarea')
  const button = document.createElement('button')
  form.append(field, button)
  ;(options.within ?? document.body).append(form)
  // jsdom lays nothing out; a connected element counts as on screen here.
  button.getClientRects = () => [{}] as unknown as DOMRectList
  const toggle = vi.fn<() => void>()
  const target: DictationTarget = {
    element: () => button,
    isActive: () => options.active ?? false,
    canStart: () => options.canStart ?? true,
    toggle,
  }
  cleanups.push(registerDictationTarget(target))
  return { target: { ...target, toggle }, field, form }
}

function press(init: KeyboardEventInit = {}, on: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, bubbles: true, cancelable: true, ...init })
  on.dispatchEvent(event)
  return event
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.innerHTML = ''
})

describe('isDictationShortcut', () => {
  it('is Control+M and nothing more', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', ...init })
    expect(isDictationShortcut(key({ ctrlKey: true }))).toBe(true)
    expect(isDictationShortcut(key({ ctrlKey: true, key: 'M' }))).toBe(true)
    expect(isDictationShortcut(key({}))).toBe(false)
    // ⌘M minimizes; ⌘⇧M / Ctrl⇧M mutes the microphone in voice mode.
    expect(isDictationShortcut(key({ metaKey: true }))).toBe(false)
    expect(isDictationShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(isDictationShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false)
  })
})

describe('the dictation shortcut', () => {
  it('toggles the only mic on the page and keeps the key from the text field', () => {
    const { target, field } = mic()
    const seen = vi.fn()
    field.addEventListener('keydown', seen)
    const event = press({}, field)
    expect(target.toggle).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(seen).not.toHaveBeenCalled()
  })

  it('does not fire again while the keys are held', () => {
    const { target } = mic()
    press()
    press({ repeat: true })
    expect(target.toggle).toHaveBeenCalledTimes(1)
  })

  it('goes to the mic that is dictating, wherever focus is', () => {
    const idle = mic()
    const dictating = mic({ active: true, canStart: false })
    idle.field.focus()
    press()
    expect(dictating.target.toggle).toHaveBeenCalledTimes(1)
    expect(idle.target.toggle).not.toHaveBeenCalled()
  })

  it('goes to the mic of the form being worked in', () => {
    const first = mic()
    const second = mic()
    second.field.focus()
    press({}, second.field)
    expect(second.target.toggle).toHaveBeenCalledTimes(1)
    expect(first.target.toggle).not.toHaveBeenCalled()
  })

  it('goes to the first mic on the page when focus is nowhere', () => {
    const first = mic()
    const second = mic()
    press()
    expect(first.target.toggle).toHaveBeenCalledTimes(1)
    expect(second.target.toggle).not.toHaveBeenCalled()
  })

  it('goes to the modal dialog\'s mic, and to none when the dialog has no mic', () => {
    // As a modal dialog leaves the page: everything outside it hidden.
    const page = document.createElement('div')
    page.setAttribute('aria-hidden', 'true')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(page, dialog)
    const behind = mic({ within: page })
    const event = press()
    expect(behind.target.toggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)

    const inDialog = mic({ within: dialog })
    press()
    expect(inDialog.target.toggle).toHaveBeenCalledTimes(1)
    expect(behind.target.toggle).not.toHaveBeenCalled()
  })

  it('is not put off by a popover, which hides nothing', () => {
    const page = mic()
    const popover = document.createElement('div')
    popover.setAttribute('role', 'dialog')
    document.body.append(popover)
    press()
    expect(page.target.toggle).toHaveBeenCalledTimes(1)
  })

  it('leaves the key to the live browser when that has focus', () => {
    const { target } = mic()
    const canvas = document.createElement('canvas')
    document.body.append(canvas)
    const event = press({}, canvas)
    expect(target.toggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves the key alone when no mic can start', () => {
    const { target } = mic({ canStart: false })
    const event = press()
    expect(target.toggle).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('stops listening once the last mic is gone', () => {
    const { target } = mic()
    cleanups.splice(0).forEach((cleanup) => cleanup())
    press()
    expect(target.toggle).not.toHaveBeenCalled()
  })
})
