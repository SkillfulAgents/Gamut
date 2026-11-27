import { EventEmitter } from 'events'
import type { App } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import {
  forceOverlayScrollbars,
  OVERLAY_SCROLLBARS_RELAUNCH_FLAG,
  relaunchForOverlayScrollbars,
} from './overlay-scrollbars'

/** The defaults as macOS resolves them: this app's own value, else the global one. */
function defaults(appValue: string | undefined, globalValue: string) {
  let own = appValue
  return {
    getUserDefault: vi.fn(() => own ?? globalValue),
    setUserDefault: vi.fn((_key: string, _type: string, value: string) => {
      own = value
    }),
  }
}

const packaged = { argv: ['/Applications/Gamut.app/Contents/MacOS/Gamut'], canRelaunch: true }

describe('forceOverlayScrollbars', () => {
  it('writes the override on every launch', () => {
    const prefs = defaults('WhenScrolling', 'Always')
    forceOverlayScrollbars(prefs as never, packaged)
    expect(prefs.setUserDefault).toHaveBeenCalledWith('AppleShowScrollBars', 'string', 'WhenScrolling')
  })

  it.each(['Always', 'Automatic', ''])('relaunches a first launch under %j', (globalValue) => {
    expect(forceOverlayScrollbars(defaults(undefined, globalValue) as never, packaged)).toBe(true)
  })

  it('does not relaunch once the override was saved by an earlier launch', () => {
    expect(forceOverlayScrollbars(defaults('WhenScrolling', 'Always') as never, packaged)).toBe(false)
  })

  it('does not relaunch when the system already shows them while scrolling', () => {
    expect(forceOverlayScrollbars(defaults(undefined, 'WhenScrolling') as never, packaged)).toBe(false)
  })

  it('does not relaunch a launch that cannot (dev, App Sandbox), but still writes', () => {
    const prefs = defaults(undefined, 'Always')
    expect(forceOverlayScrollbars(prefs as never, { ...packaged, canRelaunch: false })).toBe(false)
    expect(prefs.setUserDefault).toHaveBeenCalled()
  })

  it('never relaunches the relaunched process, even if the write did not take', () => {
    const prefs = defaults(undefined, 'Always')
    prefs.setUserDefault.mockImplementation(() => {})
    const argv = [...packaged.argv, OVERLAY_SCROLLBARS_RELAUNCH_FLAG]
    expect(forceOverlayScrollbars(prefs as never, { argv, canRelaunch: true })).toBe(false)
  })
})

function launchingApp() {
  const emitter = new EventEmitter()
  let ready!: () => void
  const whenReady = new Promise<void>((resolve) => (ready = resolve))
  const app = Object.assign(emitter, {
    whenReady: () => whenReady,
    relaunch: vi.fn(),
    exit: vi.fn(),
  })
  return { app, asApp: app as unknown as App, ready: () => ready() }
}

describe('relaunchForOverlayScrollbars', () => {
  const argv = ['/Applications/Gamut.app/Contents/MacOS/Gamut', '--some-flag']

  it('relaunches with the same arguments once ready, without starting', async () => {
    const { app, asApp, ready } = launchingApp()
    const start = vi.fn()
    const done = relaunchForOverlayScrollbars(asApp, argv, start)
    expect(app.relaunch).not.toHaveBeenCalled()
    ready()
    await done
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['--some-flag', OVERLAY_SCROLLBARS_RELAUNCH_FLAG] })
    expect(app.exit).toHaveBeenCalledWith(0)
    expect(start).not.toHaveBeenCalled()
  })

  it.each([
    ['open-url', ['superagent://platform-auth-callback?code=x']],
    ['open-file', ['/Users/me/notes.md']],
    ['continue-activity', ['com.apple.corespotlightitem', {}]],
  ])('starts as it is when macOS opened the launch with %s', async (event, args) => {
    const { app, asApp, ready } = launchingApp()
    const start = vi.fn()
    const done = relaunchForOverlayScrollbars(asApp, argv, start)
    app.emit(event, { preventDefault() {} }, ...args)
    ready()
    await done
    expect(start).toHaveBeenCalledTimes(1)
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).not.toHaveBeenCalled()
  })

  it('stops listening once ready', async () => {
    const { app, asApp, ready } = launchingApp()
    const done = relaunchForOverlayScrollbars(asApp, argv, vi.fn())
    ready()
    await done
    expect(['open-url', 'open-file', 'continue-activity'].map((e) => app.listenerCount(e))).toEqual([0, 0, 0])
  })
})
