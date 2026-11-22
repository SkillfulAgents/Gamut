/**
 * The checks on one agent's container, which the agent's actor owns, as it
 * owns the idle alarm: each waits on a timer of the watch's own (`IdleTimer`),
 * and nothing host-wide schedules them.
 *
 * - Every 300 s, whether the container runs. A container can exit without
 *   this process (a crash, a kill, a runtime that restarted), and a read that
 *   failed shows a running container as stopped. So this runs from the time
 *   the container runtime has a client until the runtime is dropped, whatever
 *   the container last read as.
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
import { processIdleTimer, type IdleTimer } from './idle-alarm'

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
  /**
   * What each check waits with between passes, read once per check at its
   * first start; this process's timer unless the deployment gives one (see
   * `IdleTimer`).
   */
  timer?(): IdleTimer
}

/**
 * The way from the container layer to the agents' watches, which their actors
 * own. Attached to the container host by the agent registry, like
 * `AgentIdleAlarms`.
 */
export interface AgentContainerWatches {
  /** The agent's watch, from an actor made if none is held: a running container always has one. */
  get(slug: string): ContainerWatch
  /** The agent's watch when its actor is held. A stop or a drop never makes an actor. */
  peek(slug: string): ContainerWatch | undefined
}

/** One check that runs every `intervalMs` while it is on. */
class RecurringCheck {
  private on = false
  private waiting: IdleTimer | undefined

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly slots: ReturnType<typeof pLimit>,
    private readonly check: () => Promise<void>,
    private readonly timer: () => IdleTimer,
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

  private arm(): void {
    (this.waiting ??= this.timer()).set(this.intervalMs, () => background(this.pass(), { name: this.name }))
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
    const timer = () => deps.timer?.() ?? processIdleTimer()
    this.status = new RecurringCheck('container-watch.status', STATUS_CHECK_INTERVAL_MS, statusSlots, () => deps.checkStatus(), timer)
    this.health = new RecurringCheck('container-watch.health', HEALTH_CHECK_INTERVAL_MS, healthSlots, () => deps.checkHealth(), timer)
  }

  /** Start the status check; nothing when it runs already. */
  start(): void {
    this.status.start()
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
