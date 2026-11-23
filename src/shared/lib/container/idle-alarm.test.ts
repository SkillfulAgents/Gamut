import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { background } from '../background'
import { IDLE_ALARM_RETRY_MS, IdleAlarm, autoSleepTimeoutMsFrom } from './idle-alarm'
import { MAX_TIMER_MS, processTimer } from './process-timer'

const MINUTE = 60_000
const TIMEOUT = 30 * MINUTE
const T0 = new Date('2026-03-01T12:00:00Z').getTime()

/**
 * An alarm over a fake container: a clock, a busy flag, and a stop that takes
 * the container down. Its wake-up is a timer of this process, as a local
 * actor's is; with `ownWakeUp`, nothing in this process wakes it, as for an
 * actor whose wake-up lives outside its process.
 */
function fakeContainer(options: { timeoutMs?: number; stopCompletes?: boolean; ownWakeUp?: boolean } = {}) {
  const state = {
    lastActivityAt: undefined as number | undefined,
    busy: false,
    timeoutMs: options.timeoutMs ?? TIMEOUT,
    stopCompletes: options.stopCompletes ?? true,
  }
  const timer = processTimer()
  // The timeout is a settings read: asynchronous, and read fresh every time.
  const timeoutMs = vi.fn(async () => state.timeoutMs)
  const lastActivityAt = vi.fn(() => state.lastActivityAt)
  const wakeAt = vi.fn((at: number) => {
    if (!options.ownWakeUp) timer.set(at - Date.now(), () => background(alarm.fire(), { name: 'test.idle-wake' }))
  })
  const cancelWake = vi.fn(() => timer.clear())
  /** The container went down: nothing on its clock, and its runtime disarms the alarm. */
  const down = () => {
    state.lastActivityAt = undefined
    alarm.disarm()
  }
  const sleep = vi.fn(async (_timeoutMs: number) => {
    if (state.stopCompletes) down()
  })
  const alarm: IdleAlarm = new IdleAlarm({ timeoutMs, lastActivityAt, isBusy: () => state.busy, sleep, wakeAt, cancelWake })
  /** Activity: it only moves the clock. */
  const mark = (at = Date.now()) => {
    state.lastActivityAt = Math.max(state.lastActivityAt ?? -Infinity, at)
  }
  /** The container came up: its start is the first mark, and its runtime arms the alarm. */
  const up = () => {
    mark()
    alarm.arm()
  }
  return { state, sleep, timeoutMs, lastActivityAt, wakeAt, cancelWake, alarm, mark, up, down }
}

/** Let the timeout reads in flight land, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('autoSleepTimeoutMsFrom', () => {
  it('is the setting in ms: 30 minutes unless set, and zero when auto-sleep is off', () => {
    expect(autoSleepTimeoutMsFrom({ app: {} } as Parameters<typeof autoSleepTimeoutMsFrom>[0])).toBe(30 * MINUTE)
    expect(autoSleepTimeoutMsFrom({ app: { autoSleepTimeoutMinutes: 5 } } as Parameters<typeof autoSleepTimeoutMsFrom>[0])).toBe(5 * MINUTE)
    expect(autoSleepTimeoutMsFrom({ app: { autoSleepTimeoutMinutes: 0 } } as Parameters<typeof autoSleepTimeoutMsFrom>[0])).toBe(0)
  })
})

describe('IdleAlarm', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sleeps the container one timeout after it came up', async () => {
    const { sleep, alarm, wakeAt, up } = fakeContainer()
    up()
    await settle()
    expect(alarm.isArmed()).toBe(true)
    expect(wakeAt).toHaveBeenCalledWith(T0 + TIMEOUT)

    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(sleep).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(TIMEOUT)
    expect(alarm.isArmed()).toBe(false)
  })

  it('activity pushes the sleep back without touching the alarm: the wake-up that finds it waits for the rest', async () => {
    const { sleep, timeoutMs, wakeAt, mark, up } = fakeContainer()
    up()
    await settle()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    // A burst of activity: no read of the timeout, no wake-up set.
    for (let i = 0; i < 5; i++) mark()
    expect(timeoutMs).toHaveBeenCalledTimes(1)
    expect(wakeAt).toHaveBeenCalledTimes(1)

    // The wake-up at 30 minutes finds the activity at 20, and waits until 50.
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(sleep).not.toHaveBeenCalled()
    expect(wakeAt).toHaveBeenCalledTimes(2)
    expect(wakeAt).toHaveBeenLastCalledWith(T0 + 50 * MINUTE)

    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1)
    expect(sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('counts from the last activity when it is armed: the rest of the timeout, or at once when that is past', async () => {
    const recent = fakeContainer()
    recent.mark(T0 - 25 * MINUTE)
    recent.alarm.arm()
    await vi.advanceTimersByTimeAsync(5 * MINUTE - 1)
    expect(recent.sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(recent.sleep).toHaveBeenCalledTimes(1)

    const stale = fakeContainer()
    stale.mark(T0 - TIMEOUT - MINUTE)
    stale.alarm.arm()
    await settle()
    expect(stale.sleep).toHaveBeenCalledTimes(1)
  })

  it('waits another full timeout while the container is busy', async () => {
    const { state, sleep, alarm, up } = fakeContainer()
    up()
    state.busy = true
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(true)

    // The turn ends without new activity (nothing wrote): the next wake-up sleeps.
    state.busy = false
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('waits for nothing while auto-sleep is off, and reads the setting again when the container is next reported up', async () => {
    const { state, sleep, alarm, wakeAt, mark, up } = fakeContainer({ timeoutMs: 0 })
    up()
    await settle()
    expect(alarm.isArmed()).toBe(false)
    expect(wakeAt).not.toHaveBeenCalled()

    // Turned on: nothing here hears of it.
    state.timeoutMs = TIMEOUT
    await vi.advanceTimersByTimeAsync(10 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(false)

    // The next status read that finds the container running arms the alarm.
    mark()
    alarm.arm()
    await settle()
    expect(alarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('stops waiting when its wake-up finds auto-sleep turned off', async () => {
    const { state, sleep, alarm, up } = fakeContainer()
    up()
    await settle()
    state.timeoutMs = 0
    await vi.advanceTimersByTimeAsync(10 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(false)
  })

  it('a changed timeout applies at the next wake-up, not before', async () => {
    const shortened = fakeContainer()
    shortened.up()
    await settle()
    shortened.state.timeoutMs = 5 * MINUTE
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(shortened.sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(shortened.sleep).toHaveBeenCalledWith(5 * MINUTE)

    vi.setSystemTime(T0)
    const lengthened = fakeContainer()
    lengthened.up()
    await settle()
    lengthened.state.timeoutMs = 2 * TIMEOUT
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT - 1)
    expect(lengthened.sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(lengthened.sleep).toHaveBeenCalledWith(2 * TIMEOUT)
  })

  it('waits for nothing with nothing to sleep', async () => {
    const { sleep, alarm, wakeAt } = fakeContainer()
    alarm.arm()
    await settle()
    expect(alarm.isArmed()).toBe(false)
    expect(wakeAt).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('tries again a minute later when the stop did not complete, until the container is down', async () => {
    const { state, sleep, alarm, up } = fakeContainer({ stopCompletes: false })
    up()
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS - 1)
    expect(sleep).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(2)

    state.stopCompletes = true
    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(3)
    expect(alarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(10 * IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('tries again after a stop that threw, and logs it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sleep, alarm, up } = fakeContainer()
    sleep.mockRejectedValueOnce(new Error('runner is down'))
    up()
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(errors).toHaveBeenCalledWith('[IdleAlarm] Sleep failed; will retry:', expect.any(Error))
    expect(alarm.isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(alarm.isArmed()).toBe(false)
  })

  it('tries again a minute later when the timeout cannot be read', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sleep, timeoutMs, alarm, wakeAt, up } = fakeContainer()
    timeoutMs.mockRejectedValueOnce(new Error('database is locked'))
    up()
    await settle()
    expect(errors).toHaveBeenCalledWith('[IdleAlarm] Could not read the auto-sleep timeout; will retry:', expect.any(Error))
    expect(alarm.isArmed()).toBe(true)
    expect(wakeAt).toHaveBeenLastCalledWith(T0 + IDLE_ALARM_RETRY_MS)

    await vi.advanceTimersByTimeAsync(IDLE_ALARM_RETRY_MS)
    expect(wakeAt).toHaveBeenLastCalledWith(T0 + TIMEOUT)
    await vi.advanceTimersByTimeAsync(TIMEOUT - IDLE_ALARM_RETRY_MS)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('disarm drops the wake-up, and the container coming up again arms anew', async () => {
    const { sleep, alarm, cancelWake, up, down } = fakeContainer()
    up()
    await settle()
    down()
    expect(alarm.isArmed()).toBe(false)
    expect(cancelWake).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()

    up()
    await settle()
    expect(alarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('arming an armed alarm does nothing: no read, and the wake-up is not moved', async () => {
    const { sleep, timeoutMs, alarm, wakeAt, up } = fakeContainer()
    up()
    await settle()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    alarm.arm()
    alarm.arm()
    await settle()
    expect(timeoutMs).toHaveBeenCalledTimes(1)
    expect(wakeAt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('a wake-up that comes early waits for the rest', async () => {
    const { sleep, alarm, wakeAt, up } = fakeContainer()
    up()
    await settle()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    await alarm.fire()
    expect(sleep).not.toHaveBeenCalled()
    expect(wakeAt).toHaveBeenLastCalledWith(T0 + TIMEOUT)
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('waits out a timeout longer than a Node timer, without sleeping early', async () => {
    const LONG = MAX_TIMER_MS + 1000
    const { sleep, alarm, up } = fakeContainer({ timeoutMs: LONG })
    up()
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS)
    expect(sleep).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(sleep).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('decisions never overlap: one asked for during a sleep in flight is made after it', async () => {
    const { sleep, alarm, mark, down } = fakeContainer()
    let finishStop!: () => void
    sleep.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishStop = () => {
        down()
        resolve()
      }
    }))
    mark(T0 - TIMEOUT - 1)
    const first = alarm.fire()
    await settle()
    expect(sleep).toHaveBeenCalledTimes(1)

    const second = alarm.fire()
    await settle()
    expect(sleep).toHaveBeenCalledTimes(1)

    finishStop()
    await Promise.all([first, second])
    // The second decision found the container down.
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(false)
  })

  it('a container that went down while the timeout was being read is left alone', async () => {
    const { timeoutMs, lastActivityAt, alarm, wakeAt, up, down } = fakeContainer()
    let landRead!: () => void
    timeoutMs.mockImplementationOnce(() => new Promise((resolve) => {
      landRead = () => resolve(TIMEOUT)
    }))
    up()
    down()
    lastActivityAt.mockClear()
    landRead()
    await settle()
    // Not even asked whether it runs: its actor may be gone.
    expect(lastActivityAt).not.toHaveBeenCalled()
    expect(wakeAt).not.toHaveBeenCalled()
    expect(alarm.isArmed()).toBe(false)
  })

  it('a container that came back up while a decision was in flight gets a decision of its own', async () => {
    const { sleep, timeoutMs, alarm, wakeAt, up, down } = fakeContainer()
    let landRead!: () => void
    timeoutMs.mockImplementationOnce(() => new Promise((resolve) => {
      landRead = () => resolve(TIMEOUT)
    }))
    up()
    down()
    await vi.advanceTimersByTimeAsync(MINUTE)
    up()
    landRead()
    await settle()
    expect(timeoutMs).toHaveBeenCalledTimes(2)
    expect(alarm.isArmed()).toBe(true)
    expect(wakeAt).toHaveBeenLastCalledWith(T0 + MINUTE + TIMEOUT)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('an actor with a wake-up of its own: nothing in this process fires, and its fire() sleeps the container', async () => {
    const { sleep, alarm, wakeAt, cancelWake, up } = fakeContainer({ ownWakeUp: true })
    up()
    await settle()
    expect(wakeAt).toHaveBeenCalledTimes(1)
    expect(wakeAt).toHaveBeenCalledWith(T0 + TIMEOUT)

    // This process's timers go off, and nothing sleeps.
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(sleep).not.toHaveBeenCalled()

    // The actor's wake-up goes off, perhaps in a process that never armed this alarm.
    await alarm.fire()
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(cancelWake).toHaveBeenCalledTimes(1)
    expect(alarm.isArmed()).toBe(false)
  })
})

describe('processTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs once when its time comes; a new set replaces the old one, and clear drops it', async () => {
    const timer = processTimer()
    const first = vi.fn()
    const second = vi.fn()
    timer.set(1000, first)
    timer.set(2000, second)
    await vi.advanceTimersByTimeAsync(2000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    timer.set(1000, first)
    timer.clear()
    await vi.advanceTimersByTimeAsync(5000)
    expect(first).not.toHaveBeenCalled()
  })

  it('goes off at once for a time already past, and at the longest Node timer for one beyond it', async () => {
    const timer = processTimer()
    const fire = vi.fn()
    timer.set(-5000, fire)
    await vi.advanceTimersByTimeAsync(0)
    expect(fire).toHaveBeenCalledTimes(1)

    timer.set(MAX_TIMER_MS + 5000, fire)
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS)
    expect(fire).toHaveBeenCalledTimes(2)
  })
})
