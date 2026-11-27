import type { App, SystemPreferences } from 'electron'

/**
 * Gamut keeps macOS's overlay scroll bars (shown while scrolling) even when the
 * system is set to show them always: it writes `AppleShowScrollBars =
 * WhenScrolling` into its own defaults, which macOS reads before the global
 * setting. But Chromium asks AppKit for the scroller style before the main
 * script runs, and keeps the answer for the whole run, so the write counts only
 * from the next launch. Every first launch (a new install, a new bundle id, its
 * defaults cleared) would show the always-visible scroll bars. That launch
 * relaunches itself once instead, before it opens the database or a window.
 */

const KEY = 'AppleShowScrollBars'
const OVERLAY = 'WhenScrolling'

/** Marks the relaunched process, so a write that did not take can never loop. */
export const OVERLAY_SCROLLBARS_RELAUNCH_FLAG = '--overlay-scrollbars-relaunch'

/**
 * Writes the override, and says whether this launch began without it in effect
 * and should relaunch to get it. Only a launch that can relaunch asks: not a dev
 * build, whose process `electron-vite dev` owns, nor the App Sandbox build,
 * which cannot start itself.
 */
export function forceOverlayScrollbars(
  prefs: Pick<SystemPreferences, 'getUserDefault' | 'setUserDefault'>,
  launch: { argv: readonly string[]; canRelaunch: boolean },
): boolean {
  const startedWith = prefs.getUserDefault(KEY, 'string')
  prefs.setUserDefault(KEY, 'string', OVERLAY)
  return launch.canRelaunch && startedWith !== OVERLAY && !launch.argv.includes(OVERLAY_SCROLLBARS_RELAUNCH_FLAG)
}

type LaunchingApp = Pick<App, 'on' | 'removeListener' | 'whenReady' | 'relaunch' | 'exit'>

/**
 * Relaunches once the app is ready, before anything has started. macOS delivers
 * what a launch was opened with (a link, a file, a Spotlight result) before
 * `ready`, to this process alone; if it delivered anything, this launch starts as
 * it is (the main module's own listeners queue it as usual) and the next launch
 * has overlay scroll bars.
 */
export async function relaunchForOverlayScrollbars(
  app: LaunchingApp,
  argv: readonly string[],
  start: () => void,
): Promise<void> {
  let openedWith: string | undefined
  const onUrl = () => (openedWith ??= 'a link')
  const onFile = () => (openedWith ??= 'a file')
  const onActivity = () => (openedWith ??= 'an activity')
  app.on('open-url', onUrl)
  app.on('open-file', onFile)
  app.on('continue-activity', onActivity)
  await app.whenReady()
  app.removeListener('open-url', onUrl)
  app.removeListener('open-file', onFile)
  app.removeListener('continue-activity', onActivity)

  if (openedWith) {
    console.log(`Overlay scroll bars take effect next launch: this one was opened with ${openedWith}`)
    start()
    return
  }
  console.log('Relaunching once so the overlay scroll bars take effect')
  app.relaunch({ args: [...argv.slice(1), OVERLAY_SCROLLBARS_RELAUNCH_FLAG] })
  app.exit(0)
}
