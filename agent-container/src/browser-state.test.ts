import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  attachBrowserSession,
  browserSessionOf,
  browserSessions,
  detachBrowserSession,
  getBrowserState,
  onBrowserSessionReleased,
  releaseBrowserSession,
  renameBrowserSession,
  resetBrowserState,
  setBrowserState,
} from './browser-state'

const ACTIVE = { active: true, cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/x', location: 'container' } as const

describe('browser-state', () => {
  const released = vi.fn()

  beforeEach(() => {
    resetBrowserState()
    released.mockReset()
    onBrowserSessionReleased(released)
  })

  describe('sessions of one browser', () => {
    it('each session that opened it has its own instance; one that did not has none', () => {
      setBrowserState({ ...ACTIVE })
      const a = attachBrowserSession('session-1')
      const b = attachBrowserSession('session-2')

      expect(browserSessionOf('session-1')).toBe(a)
      expect(browserSessionOf('session-2')).toBe(b)
      expect(browserSessionOf('session-3')).toBeNull()
      expect(a.key).not.toBe(b.key)
      expect(browserSessions()).toEqual([a, b])
    })

    it('names instances apart across browsers, so a new one never starts bound to an old tab', () => {
      setBrowserState({ ...ACTIVE })
      const first = attachBrowserSession('session-1').key
      resetBrowserState()
      setBrowserState({ ...ACTIVE })
      expect(attachBrowserSession('session-1').key).not.toBe(first)
    })

    it('has no sessions once the browser is inactive', () => {
      setBrowserState({ ...ACTIVE })
      attachBrowserSession('session-1')
      setBrowserState({ ...ACTIVE, active: false })
      expect(browserSessionOf('session-1')).toBeNull()
      setBrowserState({ ...ACTIVE })
      expect(browserSessionOf('session-1')).toBeNull()
    })

    it('detaches one session and leaves the others', () => {
      setBrowserState({ ...ACTIVE })
      const a = attachBrowserSession('session-1')
      const b = attachBrowserSession('session-2')
      detachBrowserSession(a)
      expect(browserSessions()).toEqual([b])
      expect(getBrowserState().active).toBe(true)
    })
  })

  describe('releaseBrowserSession', () => {
    it('drops the session and hands it to the server, saying whether it was the last', () => {
      setBrowserState({ ...ACTIVE })
      const a = attachBrowserSession('session-1')
      const b = attachBrowserSession('session-2')

      expect(releaseBrowserSession('session-1')).toBe(true)
      expect(released).toHaveBeenLastCalledWith(a, false)
      expect(browserSessionOf('session-1')).toBeNull()

      expect(releaseBrowserSession('session-2')).toBe(true)
      expect(released).toHaveBeenLastCalledWith(b, true)
    })

    it('leaves the browser inactive but where it was once the last session is released', () => {
      setBrowserState({ ...ACTIVE })
      attachBrowserSession('session-1')
      releaseBrowserSession('session-1')
      expect(getBrowserState()).toEqual({ ...ACTIVE, active: false })
    })

    it('does nothing for a session that was not using the browser', () => {
      setBrowserState({ ...ACTIVE })
      attachBrowserSession('session-1')
      expect(releaseBrowserSession('session-2')).toBe(false)
      expect(released).not.toHaveBeenCalled()
      expect(browserSessions()).toHaveLength(1)
    })

    it('returns false when the browser is not active', () => {
      expect(releaseBrowserSession('session-1')).toBe(false)
    })
  })

  describe('renameBrowserSession', () => {
    it('re-keys the session when its id changes (query restart mid-browse), keeping its instance and its earlier id', () => {
      setBrowserState({ ...ACTIVE })
      const s = attachBrowserSession('old-id')
      const key = s.key
      expect(renameBrowserSession('old-id', 'new-id')).toBe(true)
      expect(browserSessionOf('new-id')).toBe(s)
      expect(browserSessionOf('old-id')).toBe(s)
      expect(s.sessionId).toBe('new-id')
      expect(s.ids()).toEqual(['new-id', 'old-id'])
      expect(s.key).toBe(key)
      expect(browserSessions()).toEqual([s])
    })

    it('releases the session by the id it had before, as the session manager may know it', () => {
      setBrowserState({ ...ACTIVE })
      const s = attachBrowserSession('old-id')
      attachBrowserSession('other-session')
      renameBrowserSession('old-id', 'new-id')
      expect(releaseBrowserSession('old-id')).toBe(true)
      expect(released).toHaveBeenLastCalledWith(s, false)
      expect(browserSessionOf('new-id')).toBeNull()
      expect(browserSessions().map(b => b.sessionId)).toEqual(['other-session'])
    })

    it('does nothing when the old id is not using the browser', () => {
      setBrowserState({ ...ACTIVE })
      attachBrowserSession('other-session')
      expect(renameBrowserSession('old-id', 'new-id')).toBe(false)
      expect(browserSessionOf('other-session')).not.toBeNull()
    })

    it('does nothing when the browser is inactive', () => {
      expect(renameBrowserSession('old-id', 'new-id')).toBe(false)
      expect(getBrowserState().active).toBe(false)
    })
  })

  describe('a finished cron session (SUP-167)', () => {
    it('does not keep the next cron session from the browser, with or without release', () => {
      setBrowserState({ ...ACTIVE })
      attachBrowserSession('cron-session-1')
      // The next run opens its own use of the same browser either way.
      expect(attachBrowserSession('cron-session-2')).toBe(browserSessionOf('cron-session-2'))
      releaseBrowserSession('cron-session-1')
      expect(browserSessions().map(s => s.sessionId)).toEqual(['cron-session-2'])
    })
  })
})
