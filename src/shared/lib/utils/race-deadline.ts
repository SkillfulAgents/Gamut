/**
 * Race a promise against an absolute deadline (epoch ms). Resolves to its
 * value, or to `DEADLINE` once the deadline passes first; a deadline already
 * past answers `DEADLINE` at once, without waiting on the promise.
 *
 * The losing promise keeps running: a caller that gets `DEADLINE` decides what
 * happens when (or if) it settles, and attaches its own rejection handler to
 * it, so a late failure does not become an unhandled rejection.
 */
export const DEADLINE = Symbol('deadline')

export async function raceDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | typeof DEADLINE> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) return DEADLINE
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<typeof DEADLINE>((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), remainingMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
