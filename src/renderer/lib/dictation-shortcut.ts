import { getPlatform } from '@renderer/lib/env'

/**
 * The dictation shortcut: Control+M on every platform, pressed once to start
 * dictating and again to stop and keep the text.
 *
 * Why this one. It is what Codex and Cursor's agent window use for dictation,
 * and M is the microphone. The Space combinations other apps toggle voice with
 * are taken here: ⌃⇧Space is this app's own launcher (whose second press
 * already dictates), and ⌘⇧Space belongs to macOS 27. Control rather than ⌘
 * on a Mac, as with the launcher, because ⌘M minimizes the window. The system
 * dictation tools' keys (Fn, Caps Lock, Ctrl+Win) never reach a web page.
 *
 * Every mounted mic button registers as a target; the shortcut goes to one of
 * them (see `pickTarget`).
 */
export interface DictationTarget {
  /** The mic button, for where it sits in the page. */
  element: () => HTMLElement | null
  /** Dictating now (the shortcut stops it). */
  isActive: () => boolean
  /** Idle and able to start. */
  canStart: () => boolean
  toggle: () => void
}

const targets = new Set<DictationTarget>()

export function isDictationShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
  return event.code === 'KeyM' || event.key.toLowerCase() === 'm'
}

function isMac(): boolean {
  const platform = getPlatform()
  if (platform) return platform === 'darwin'
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

/** The shortcut's keys as chips: one per key. */
export function dictationShortcutKeys(): string[] {
  return isMac() ? ['⌃', 'M'] : ['Ctrl', 'M']
}

/** The shortcut in a line of text (a tooltip, an aria label). */
export function dictationShortcutLabel(): string {
  return isMac() ? '⌃M' : 'Ctrl+M'
}

/**
 * What a mic button's keys act within: its form, or the box around it when it
 * has none. Focus inside it means the person is working there.
 */
export function dictationScope(element: HTMLElement): HTMLElement {
  return element.closest<HTMLElement>('form, [data-dictation-scope]') ?? element.parentElement ?? element
}

/**
 * On screen and reachable. A modal dialog hides the page under it from
 * assistive technology (`aria-hidden`, or `inert`), which is also how a mic
 * behind one is told from the one in it; a popover or a side panel hides nothing.
 */
function isReachable(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"], [inert]')
}

/**
 * Which mic the shortcut means. One that is dictating, to stop it. Otherwise
 * the one the person is working in (focus is inside its scope); otherwise the
 * first on the page. A mic under a modal dialog is not offered, so with a
 * dialog open it is the dialog's mic or none.
 */
export function pickTarget(candidates: Iterable<DictationTarget> = targets): DictationTarget | null {
  const reachable: Array<{ target: DictationTarget; element: HTMLElement }> = []
  for (const target of candidates) {
    const element = target.element()
    if (target.isActive()) return target
    if (isReachable(element) && target.canStart()) reachable.push({ target, element })
  }
  if (reachable.length === 0) return null
  reachable.sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))

  const focused = document.activeElement
  if (focused && focused !== document.body) {
    const working = reachable.find(({ element }) => dictationScope(element).contains(focused))
    if (working) return working.target
  }
  return reachable[0].target
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || !isDictationShortcut(event)) return
  // A focused canvas is the live browser, which forwards its keys to the page it shows.
  if (event.target instanceof HTMLCanvasElement) return
  const target = pickTarget()
  if (!target) return
  // Ours from here: a text field must not also take it as a key of its own.
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) target.toggle()
}

/** Offer a mic button to the shortcut for as long as it is mounted. */
export function registerDictationTarget(target: DictationTarget): () => void {
  // Capture phase: an editor's own key handling never sees the shortcut.
  if (targets.size === 0) window.addEventListener('keydown', onKeyDown, true)
  targets.add(target)
  return () => {
    targets.delete(target)
    if (targets.size === 0) window.removeEventListener('keydown', onKeyDown, true)
  }
}
