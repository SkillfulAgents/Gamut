/**
 * Frames, for browser_frame: what the page embeds and how to select it, and
 * what the selected one is.
 *
 * agent-browser 0.45 selects a frame by CSS selector or by the ref of its
 * `Iframe` line, cross-origin ones included (upstream #2737), and `eval`,
 * `wait`, `find` and the selector commands then act inside it (#2738). The
 * snapshot reads into frames on its own, so a field's ref works without
 * selecting anything; selecting is for what refs do not reach: a script, a
 * wait for a selector, the frame's text. Mining theme 11: agents that
 * believed a frame "not inspectable" spent ~170 calls; one inventory with
 * the commands that work would have ended it.
 */
import type { IframeInfo } from './page-observer'

/** A frame of the page, by what browser_frame takes. */
export interface FrameEntry {
  /** The ref of its `Iframe` line in the page's tree, when it has one. */
  ref: string | null
  /** Its name as the tree prints it (accessible name, else title, else name attribute). */
  title: string
  host: string
  sameOrigin: boolean
}

/** The `Iframe` lines of a tree: their refs and names. */
export function treeFrameRefs(tree: string): Array<{ ref: string; title: string }> {
  const out: Array<{ ref: string; title: string }> = []
  for (const line of tree.split('\n')) {
    const m = /^\s*- iframe(?: "((?:[^"\\]|\\.)*)")?[^\n]*?\bref=(e\d+)/i.exec(line)
    if (m) out.push({ ref: m[2], title: (m[1] ?? '').replace(/\\(.)/g, '$1').trim() })
  }
  return out
}

/**
 * The page's visible frames (the observer's, top frame) with the ref of the
 * tree line that has the same name. Two frames of one name share no ref:
 * which line is which is not known. Tree frames the observer did not list
 * (hidden by its visibility test) are left out.
 */
export function frameInventory(iframes: IframeInfo[], tree: string): FrameEntry[] {
  const lines = treeFrameRefs(tree)
  return iframes.filter(f => f.host || f.title).map(f => {
    const title = f.title.trim()
    const named = title ? lines.filter(l => l.title === title) : []
    const sameName = iframes.filter(o => o.title.trim() === title).length
    return { ref: named.length === 1 && sameName === 1 ? named[0].ref : null, title, host: f.host, sameOrigin: f.sameOrigin }
  })
}

/** The inventory as the agent reads it: one line per frame, with what selects it. */
export function formatFrameInventory(entries: FrameEntry[], selected: string | null): string {
  if (entries.length === 0) {
    return selected
      ? `Frame ${selected} is selected. The page shows no other frames.`
      : 'The page shows no frames.'
  }
  const lines = entries.slice(0, 20).map(f => {
    const name = f.title ? JSON.stringify(f.title.slice(0, 80)) : 'unnamed'
    const where = f.host ? ` (${f.host}${f.sameOrigin ? '' : ', cross-origin'})` : ''
    const how = f.ref ? ` — browser_frame("@${f.ref}")` : ''
    return `- ${name}${where}${how}`
  })
  const more = entries.length > 20 ? `\n… ${entries.length - 20} more` : ''
  const head = selected ? `Frame ${selected} is selected; the page's frames:` : `Frames on the page (${entries.length}):`
  return `${head}\n${lines.join('\n')}${more}`
}

/** The selected frame's address and title, read inside it; null on the top frame. */
export const FRAME_INFO_SCRIPT =
  '(window.top === window ? null : JSON.stringify({u:String(location.href),t:String(document.title||"")}))'

export interface SelectedFrame {
  /** What the agent selected it with: a ref or a selector. */
  target: string
  url: string
  title: string
}

/** FRAME_INFO_SCRIPT's answer as the CLI prints it, or null (the top frame, or no answer). */
export function parseFrameInfo(stdout: string, target: string): SelectedFrame | null {
  try {
    const outer: unknown = JSON.parse(stdout.trim())
    if (typeof outer !== 'string') return null
    const inner = JSON.parse(outer) as { u?: unknown; t?: unknown }
    if (typeof inner.u !== 'string') return null
    return { target, url: inner.u, title: typeof inner.t === 'string' ? inner.t : '' }
  } catch {
    return null
  }
}

/**
 * A frame's address as the agent is shown it: origin and path. Embedded
 * frames carry their parent's state in the query and fragment (a Stripe card
 * frame's URL runs to ~500 characters of parameters), which says nothing
 * about which frame it is.
 */
export function frameUrlShown(url: string): string {
  try {
    const u = new URL(url)
    // about:srcdoc, about:blank, data: and blob: frames have no origin to show.
    if (u.origin === 'null') return url.length > 120 ? `${url.slice(0, 119)}…` : url
    const path = u.pathname.length > 100 ? `${u.pathname.slice(0, 99)}…` : u.pathname
    return `${u.origin}${path}${u.search || u.hash ? '?…' : ''}`
  } catch {
    return url.length > 120 ? `${url.slice(0, 119)}…` : url
  }
}

/** The status line's frame part: where the selected frame is. */
export function formatFrameLine(frame: SelectedFrame, refCount: number | null): string {
  const facts = [frameUrlShown(frame.url), frame.title ? JSON.stringify(frame.title.slice(0, 120)) : 'untitled']
  if (refCount !== null) facts.push(`${refCount} ref${refCount === 1 ? '' : 's'}`)
  return `[frame] ${facts.join(' · ')} — selected with browser_frame (${frame.target}); browser_frame("main") returns to the page`
}
