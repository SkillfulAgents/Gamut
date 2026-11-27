import { randomBytes } from 'crypto'
import type { BrowserRuntimeLocation } from './browser-location'
import { UrlTracker } from './browser-digest'
import type { CaptureState } from './traffic-capture'
import { TreeBaselines } from './tree-diff'

/**
 * The agent's browser: one Chrome, which every session of the agent can use at
 * the same time. Its tabs, cookies and logins are the agent's. Each session
 * that opened it drives an agent-browser instance of its own, pinned to the tab
 * that session is on (BrowserSession).
 */
export interface BrowserState {
  active: boolean;
  /** The endpoint every session's instance attaches to: the container Chrome's, or the host's. */
  cdpUrl: string | null;
  location: BrowserRuntimeLocation | null;
}

/** One session's use of the browser: its agent-browser instance, and what the browser tools keep between its calls. */
export class BrowserSession {
  readonly trees = new TreeBaselines()
  readonly urls = new UrlTracker()
  capture: CaptureState | null = null
  /** The tabs (CDP target ids) this session opened: its first tab, `tab new`, and the pages its tabs opened. */
  readonly opened = new Set<string>()
  /** The browser's tabs when this session last looked: a tab not among them is new. */
  seenTabs = new Set<string>()
  /** Its tabs as last counted (session-tabs.ts ownTabCount), for tab-limit warnings. */
  tabCount = 1
  /** The ids the session had before (renameBrowserSession): what was keyed to it then is still its own. */
  readonly formerIds = new Set<string>()
  /**
   * The frame the agent selected with `frame <target>` (browser_run), as it
   * named it; null for the top frame. Cleared when a probe finds the instance
   * back on the top frame (a navigation or a tab change resets it).
   */
  frame: string | null = null
  /** Held while the harness steps out of the agent's frame to read the top page (top-frame-probe.ts). */
  frameStep: Promise<void> | null = null

  /** Every id the session has had, the current one first. */
  ids(): string[] {
    return [this.sessionId, ...this.formerIds]
  }

  constructor(
    /** The session using it. Changes when the session adopts a new id (renameBrowserSession). */
    public sessionId: string,
    /**
     * The instance's `--session` name, fixed for its life. Unique across
     * container restarts too: agent-browser keeps a session's tab binding on
     * disk, and a reused name would start out bound to a tab of an old Chrome.
     */
    readonly key: string = `s-${sessionId.slice(0, 8)}-${randomBytes(3).toString('hex')}`,
  ) {}
}

const initialState: BrowserState = { active: false, cdpUrl: null, location: null };

let browserState: BrowserState = { ...initialState };
const sessions = new Map<string, BrowserSession>();
let onReleased: ((session: BrowserSession, last: boolean) => void) | null = null;

export function getBrowserState(): Readonly<BrowserState> {
  return browserState;
}

/** Set the agent's browser. An inactive one has no sessions. */
export function setBrowserState(state: BrowserState): void {
  browserState = state;
  if (!state.active) sessions.clear();
}

export function resetBrowserState(): void {
  setBrowserState({ ...initialState });
}

/**
 * The session's use of the browser, or null when it has not opened it (or
 * there is none). By any id it has had: what was keyed to an id before a
 * rename (a request it made, a release for it) still finds it.
 */
export function browserSessionOf(sessionId: string): BrowserSession | null {
  if (!browserState.active) return null;
  return sessions.get(sessionId) ?? browserSessions().find(s => s.formerIds.has(sessionId)) ?? null;
}

/** Every session using the browser now. */
export function browserSessions(): BrowserSession[] {
  return [...sessions.values()];
}

/** The session starts using the active browser. */
export function attachBrowserSession(sessionId: string): BrowserSession {
  const session = new BrowserSession(sessionId);
  sessions.set(sessionId, session);
  return session;
}

/** The session stops using the browser (its instance is closed by the caller). */
export function detachBrowserSession(session: BrowserSession): void {
  if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
}

/** What the server does with a released session's instance and tabs; `last` when no other session uses the browser. */
export function onBrowserSessionReleased(handler: (session: BrowserSession, last: boolean) => void): void {
  onReleased = handler;
}

/**
 * The session is over (deleted, evicted while idle, an automated turn done):
 * it stops using the browser. The browser and the other sessions' tabs stay.
 * The last session leaves the browser inactive but running, where it is: the
 * agent's next session launches it again there.
 * Returns false when the session was not using it.
 */
export function releaseBrowserSession(sessionId: string): boolean {
  const session = browserSessionOf(sessionId);
  if (!session) return false;
  sessions.delete(session.sessionId);
  const last = sessions.size === 0;
  if (last) browserState = { ...browserState, active: false };
  onReleased?.(session, last);
  return true;
}

/**
 * Re-key a session's use of the browser when the session adopts a new
 * canonical id. A ClaudeCodeProcess's sessionId changes whenever its SDK query
 * (re)starts (model/effort change, MCP approval restart) — without this, the
 * session's next browser call would find no browser of its own.
 *
 * Returns true if it was re-keyed, false if oldId was not using the browser.
 */
export function renameBrowserSession(oldId: string, newId: string): boolean {
  const session = sessions.get(oldId);
  if (!browserState.active || !session) return false;
  sessions.delete(oldId);
  session.formerIds.add(oldId);
  session.sessionId = newId;
  sessions.set(newId, session);
  return true;
}
