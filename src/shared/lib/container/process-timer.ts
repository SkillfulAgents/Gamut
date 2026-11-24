/**
 * One timer in this process, for what an agent's actor waits on itself: its
 * idle alarm's wake-up and its container watch's passes.
 */

/**
 * The longest delay Node's `setTimeout` honours (2^31 - 1 ms, about 24.8
 * days); anything longer is silently run after 1 ms with an overflow warning.
 * A longer wait goes off at this, so whoever set it checks its deadline again.
 */
export const MAX_TIMER_MS = 2_147_483_647

export interface ProcessTimer {
  /** Run `fire` in `ms`, in place of whatever was set before. A wait longer than `MAX_TIMER_MS` goes off at that. */
  set(ms: number, fire: () => void): void
  clear(): void
}

/** A timer that never keeps the process alive. */
export function processTimer(): ProcessTimer {
  let timer: NodeJS.Timeout | null = null
  const clear = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    set(ms, fire) {
      clear()
      timer = setTimeout(() => {
        timer = null
        fire()
      }, Math.min(Math.max(0, ms), MAX_TIMER_MS))
      timer.unref?.()
    },
    clear,
  }
}
