/**
 * The alarm that puts an idle container to sleep. Each agent's actor owns
 * one, and everything about auto-sleep is in it: nothing outside the actor
 * reads the timeout, keeps a timer or decides.
 *
 * Activity (the container's start, a keep-alive, a session write) only moves
 * the container's clock; it never touches the alarm. The alarm waits for one
 * wake-up, set when the container comes up. When the wake-up comes it reads
 * the auto-sleep timeout and the clock, and decides:
 *
 * - nothing to sleep (the container is not running, or auto-sleep is off):
 *   it stops waiting;
 * - busy (a session active or awaiting input): it waits another full timeout;
 * - active within the timeout: it waits until one timeout after that activity;
 * - otherwise it sleeps the container.
 *
 * So activity pushes the sleep back without anything being reset: the
 * wake-up that finds it waits for the rest.
 *
 * The wake-up is the actor's own (`wakeAt`). `LocalAgentActor` uses a timer
 * of its process; an actor that outlives its process uses a wake-up that does
 * too, and runs `fire()` when it goes off. A wake-up may come early: the
 * decision is made from the clock, not from having been woken.
 *
 * The timeout is a setting, read at every decision and never kept. A change
 * applies at the alarm's next wake-up, which can be as far off as the old
 * timeout. An alarm that found auto-sleep off waits for nothing, and reads
 * the setting again when the container is next reported up (its next start,
 * or the actor's next status check).
 *
 * A sleep that does not complete (stop and kill timed out with force-stop
 * disabled, which is the only escalation this alarm never takes) is tried
 * again a minute later. So is a timeout read that failed.
 */
import { background } from '../background'
import type { AppSettings } from '@shared/lib/config/settings'

/** The auto-sleep timeout in `settings`, in ms; zero or less disables. */
export function autoSleepTimeoutMsFrom(settings: Pick<AppSettings, 'app'>): number {
  return (settings.app?.autoSleepTimeoutMinutes ?? 30) * 60_000
}

/** What the alarm reads and does, all of it the actor's own. */
export interface IdleAlarmDeps {
  /**
   * How long the container may be idle before it sleeps, in ms; zero or less
   * disables. Read at every decision, never kept between them.
   */
  timeoutMs(): Promise<number>
  /**
   * The clock: when the container was last active, or undefined when there is
   * nothing to sleep (a container that is not running, or is on its way up
   * or down).
   */
  lastActivityAt(): number | undefined
  /** Whether the container is busy right now: a session active or awaiting input. */
  isBusy(): boolean
  /**
   * Put the container to sleep, idle for `timeoutMs` (the timeout this
   * decision read). A completed stop leaves nothing on the clock; one that
   * does not leaves it marked.
   */
  sleep(timeoutMs: number): Promise<void>
  /**
   * Have `fire()` run at `at` (epoch ms), in place of any wake-up set before.
   * It may run early.
   */
  wakeAt(at: number): void
  /** Drop the wake-up, if one is set. */
  cancelWake(): void
  /** The clock to read time from; `Date.now` unless a test says otherwise. */
  now?(): number
}

/** How long the alarm waits before it tries again a sleep that did not complete, or a timeout it could not read. */
export const IDLE_ALARM_RETRY_MS = 60_000

export class IdleAlarm {
  /** A wake-up is set, or the one that was set is being decided on. */
  private armed = false
  private deciding: Promise<void> | null = null
  /** A decision was asked for while one was being made: make another after it. */
  private again = false
  /**
   * Counts the disarms. A decision that was waiting (for the timeout, or for
   * the sleep) while one happened stops there: the container it was deciding
   * for went down, and its actor may be gone.
   */
  private disarms = 0

  constructor(private readonly deps: IdleAlarmDeps) {}

  /**
   * The container is up: wait for it to go idle, unless the alarm is waiting
   * already. Returns before the wake-up is set, since the timeout is read
   * first. Called for a start, and for every status read that finds the
   * container running, which costs nothing while the alarm is armed.
   */
  arm(): void {
    if (this.armed) return
    background(this.fire(), { name: 'idle-alarm.arm' })
  }

  /** The container is down, or its runtime was dropped: there is nothing to wait for. */
  disarm(): void {
    this.disarms++
    if (!this.armed) return
    this.armed = false
    this.deps.cancelWake()
  }

  isArmed(): boolean {
    return this.armed
  }

  /**
   * Decide now: sleep the container if it has been idle for the timeout,
   * otherwise wait for when it would be. What the wake-up runs. Decisions
   * never overlap: one asked for while another is being made is made after it.
   */
  fire(): Promise<void> {
    this.again = true
    return (this.deciding ??= this.run())
  }

  private async run(): Promise<void> {
    try {
      while (this.again) {
        this.again = false
        await this.decide()
      }
    } catch (error) {
      // Not left armed with no wake-up set: the next `arm()` decides again.
      this.disarm()
      throw error
    } finally {
      this.deciding = null
    }
  }

  private async decide(): Promise<void> {
    const disarms = this.disarms
    let timeoutMs: number
    try {
      timeoutMs = await this.deps.timeoutMs()
    } catch (error) {
      if (disarms !== this.disarms) return
      console.error('[IdleAlarm] Could not read the auto-sleep timeout; will retry:', error)
      // Rather than leave a running container awake for good.
      if (this.deps.lastActivityAt() === undefined) this.disarm()
      else this.waitUntil(this.now() + IDLE_ALARM_RETRY_MS)
      return
    }
    if (disarms !== this.disarms) return
    const last = this.deps.lastActivityAt()
    if (last === undefined || timeoutMs <= 0) return this.disarm()
    const now = this.now()
    // Busy: a full timeout from now. Otherwise one timeout after the last activity.
    const sleepAt = this.deps.isBusy() ? now + timeoutMs : last + timeoutMs
    if (now < sleepAt) return this.waitUntil(sleepAt)
    try {
      await this.deps.sleep(timeoutMs)
    } catch (error) {
      console.error('[IdleAlarm] Sleep failed; will retry:', error)
    }
    // A completed stop disarmed on its way down. Anything still on the clock
    // means the container is up (the stop did not complete): try again soon.
    if (disarms !== this.disarms) return
    if (this.deps.lastActivityAt() === undefined) this.disarm()
    else this.waitUntil(this.now() + IDLE_ALARM_RETRY_MS)
  }

  private waitUntil(at: number): void {
    this.armed = true
    this.deps.wakeAt(at)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
