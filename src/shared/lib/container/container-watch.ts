/**
 * The checks on one agent's container, which the agent's actor owns, as it
 * owns the idle alarm: each check waits on a timer of its own in this
 * process, and nothing host-wide schedules them.
 *
 * - Every 300 s, whether the container runs. A container can exit without
 *   this process (a crash, a kill, a runtime that restarted), and a read that
 *   failed shows a running container as stopped. So this runs from the
 *   actor's first read (or the runtime's next client) until the runner
 *   confirms the container stopped, and a start turns it back on.
 * - Every 30 s, the container's health (the memory and CPU warnings the app
 *   shows), while the runtime sees the container running.
 *
 * The next pass of a check is set when the last one ends, so passes of one
 * agent never overlap. A check that hangs holds up its own agent's passes and
 * one of the slots its kind of check has in this process; the runner reads
 * the checks make give up after a bound, which frees the slot.
 */
import pLimit from 'p-limit'
import { background } from '../background'
import { processTimer, type ProcessTimer } from './process-timer'

/** Interval for checking that a running container still runs (in ms). Default: 300 seconds */
const STATUS_CHECK_INTERVAL_MS = parseInt(
  process.env.CONTAINER_STATUS_SYNC_INTERVAL_SECONDS || '300',
  10
) * 1000

/** Interval for checking a running container's health (in ms). Default: 30 seconds */
const HEALTH_CHECK_INTERVAL_MS = parseInt(
  process.env.CONTAINER_HEALTH_CHECK_INTERVAL_SECONDS || '30',
  10
) * 1000

/**
 * Checks of one kind that run at once across this process's agents, one
 * runner call each. The watches of containers seen running together come
 * due together; the actors of one process share its runtime, so the bound
 * is theirs to keep.
 */
const CHECKS_AT_ONCE = 4
const statusSlots = pLimit(CHECKS_AT_ONCE)
const healthSlots = pLimit(CHECKS_AT_ONCE)

export interface ContainerWatchDeps {
  /** One health check of the running container. */
  checkHealth(): Promise<void>
  /** Ask the runtime whether the container still runs, and update what the app shows. */
  checkStatus(): Promise<void>
}

/** One check that runs every `intervalMs` while it is on. */
class RecurringCheck {
  private on = false
  private waiting: ProcessTimer | undefined

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly slots: ReturnType<typeof pLimit>,
    private readonly check: () => Promise<void>,
  ) {}

  isOn(): boolean {
    return this.on
  }

  start(): void {
    if (this.on) return
    this.on = true
    this.arm()
  }

  stop(): void {
    this.on = false
    this.waiting?.clear()
  }

  /** Turn on, and run a pass now instead of after the interval. */
  async runNow(): Promise<void> {
    this.on = true
    this.waiting?.clear()
    await this.pass()
  }

  private arm(): void {
    (this.waiting ??= processTimer()).set(this.intervalMs, () => background(this.pass(), { name: this.name }))
  }

  private async pass(): Promise<void> {
    try {
      // Read once a slot is free: a check stopped while this waited has nothing to check.
      await this.slots(async () => {
        if (this.on) await this.check()
      })
    } finally {
      if (this.on) this.arm()
    }
  }
}

export class ContainerWatch {
  private readonly status: RecurringCheck
  private readonly health: RecurringCheck

  constructor(deps: ContainerWatchDeps) {
    this.status = new RecurringCheck('container-watch.status', STATUS_CHECK_INTERVAL_MS, statusSlots, () => deps.checkStatus())
    this.health = new RecurringCheck('container-watch.health', HEALTH_CHECK_INTERVAL_MS, healthSlots, () => deps.checkHealth())
  }

  /** Start the status check; nothing when it runs already. */
  start(): void {
    this.status.start()
  }

  /**
   * Read whether the container runs now, then go on as `start` does: the
   * actor's first read of its container. A failed read is logged.
   */
  readNow(): Promise<void> {
    return this.status.runNow().catch((error: unknown) => {
      console.error('[ContainerWatch] The first status read failed:', error)
    })
  }

  /** The container is seen running: start the health check too. */
  startHealth(): void {
    this.status.start()
    this.health.start()
  }

  /** The container is seen stopped: its health check ends, its status check goes on. */
  stopHealth(): void {
    this.health.stop()
  }

  /** End both checks: the container's runtime or the agent's actor was dropped. */
  stop(): void {
    this.health.stop()
    this.status.stop()
  }

  isWatching(): boolean {
    return this.status.isOn()
  }

  isCheckingHealth(): boolean {
    return this.health.isOn()
  }
}
