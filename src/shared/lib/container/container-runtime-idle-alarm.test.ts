vi.mock('@shared/lib/account-providers/provider-factory', () => ({
  getDefaultAccountProvider: () => ({ name: 'composio' }),
}))
vi.mock('@shared/lib/agent-integrations/mcp', () => ({ integrationMcpProjection: vi.fn(async () => []) }))
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ============================================================================
// Mocks — must be set up before importing container-host
// ============================================================================

const mockStart = vi.fn().mockResolvedValue({ status: 'running', port: 4001 })
const mockStop = vi.fn().mockResolvedValue({ forceStopUsed: false, stopped: true })
const mockGetInfoFromRuntime = vi.fn().mockResolvedValue({ status: 'running', port: 4001 })
const mockIsDefinitelyStopped = vi.fn().mockResolvedValue(false)

vi.mock('./client-factory', () => ({
  createContainerClient: () => ({
    start: mockStart,
    stop: mockStop,
    stopSync: vi.fn(),
    getInfoFromRuntime: (...args: unknown[]) => mockGetInfoFromRuntime(...args),
    isDefinitelyStopped: () => mockIsDefinitelyStopped(),
    getStats: vi.fn(),
    fetch: vi.fn(),
    getHostApiBaseUrl: () => 'http://127.0.0.1:3000',
    createSession: vi.fn(),
    onFatalResult: () => 'settle',
    observeUnexpectedDeath: async () => ({ action: 'settle' as const }),
    getRuntimeGenerationId: () => null,
  }),
  getContainerClientClass: () => ({ requiresLocalImage: true }),
  checkAllRunnersAvailability: vi.fn().mockResolvedValue([]),
  checkImageExists: vi.fn().mockResolvedValue(true),
  pullImage: vi.fn(),
  canBuildImage: vi.fn().mockReturnValue(false),
  buildImage: vi.fn(),
  startRunner: vi.fn(),
  refreshRunnerAvailability: vi.fn(),
  clearRunnerAvailabilityCache: vi.fn(),
  getRunnerDisplayName: (runner: string) => runner,
  reconcileRunnerState: vi.fn().mockResolvedValue(false),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  getOrCreateProxyToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: vi.fn(async () => 'test-host-token'),
}))

vi.mock('@shared/lib/proxy/host-url', () => ({
  getContainerHostUrl: () => '127.0.0.1',
  getAppPort: () => 3000,
}))

vi.mock('@shared/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({ innerJoin: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
    }),
  },
}))

vi.mock('@shared/lib/db/schema', () => ({
  connectedAccounts: { id: 'id' },
  agentConnectedAccounts: 'agent_connected_accounts_table',
  agentRemoteMcps: 'agent_remote_mcps_table',
  remoteMcpServers: 'remote_mcp_servers_table',
}))

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
}))

// The timeout is read at every arm and every fire, so the tests change it in place.
const settings = { container: { agentImage: 'test-image', containerRunner: 'docker' }, app: { autoSleepTimeoutMinutes: 30 } }

const readSettings = vi.fn(async () => settings)
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => readSettings(),
}))

vi.mock('@shared/lib/config/data-dir', () => ({
  getAgentWorkspaceDir: (id: string) => `/workspace/${id}`,
}))

const mockHasActive = vi.fn(() => false)
const mockHasAwaiting = vi.fn(() => false)

vi.mock('./health-monitor', () => ({
  healthMonitor: { checkAll: vi.fn().mockReturnValue([]) },
}))

vi.mock('@shared/lib/computer-use/executor', () => ({ endComputerUseSessions: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@shared/lib/services/agent-service', () => ({}))
vi.mock('@shared/lib/composio/client', () => ({ isPlatformComposioActive: () => false, isPlatformComposioActiveFrom: () => false }))
vi.mock('@shared/lib/services/timezone-resolver', () => ({ resolveTimezoneForAgent: () => 'UTC' }))
vi.mock('@shared/lib/services/mount-service', () => ({ listVolumes: async () => ({ volumes: [], notMounted: [] }), remounted: async () => {} }))

import { containerHost } from './container-host'
import { _resetAgentRegistryForTest, agentRegistry as registry } from '@shared/lib/agent-actor/registry'
import { LiveSessions } from '@shared/lib/agent-actor/live/live-sessions'
import { LocalAgentActor } from '@shared/lib/agent-actor/local-agent-actor'
import { createRecordingHostPort } from '@shared/lib/agent-actor/testing/recording-host-port'

// The actors desktop runs, over this file's container host: each owns its idle alarm and its runtime.
_resetAgentRegistryForTest((slug) => new LocalAgentActor(slug, { containers: containerHost, host: createRecordingHostPort().port }))
// Each agent's actor holds its runtime.
const actorOf = (slug: string) => registry.get(slug) as LocalAgentActor
const agents = { runtime: (slug: string) => actorOf(slug).state.runtime(), drop: (slug: string) => actorOf(slug).state.dropRuntime() }
const alarmOf = (slug: string) => actorOf(slug).state.idleAlarm

const MINUTE = 60_000
const TIMEOUT = 30 * MINUTE
const T0 = new Date('2026-03-01T12:00:00Z').getTime()
const SLUG = 'agent-alarm'

// ============================================================================
// The actor sleeps its container
//
// The agent's idle alarm, which its actor owns, is armed when the container
// comes up and wakes one auto-sleep timeout later. Activity (keep-alive,
// session write) only moves the runtime's clock: the wake-up that finds it
// waits for the rest. The alarm stops the container through the runtime's own
// stop, never escalating to a force-stop of the shared VM.
// ============================================================================

describe('ContainerRuntime idle alarm', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    vi.clearAllMocks()
    settings.app.autoSleepTimeoutMinutes = 30
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    mockIsDefinitelyStopped.mockResolvedValue(false)
    mockHasActive.mockReturnValue(false)
    mockHasAwaiting.mockReturnValue(false)
    // The agent's live sessions, as its alarm asks them whether it is busy.
    vi.spyOn(LiveSessions.prototype, 'hasActive').mockImplementation(() => mockHasActive())
    vi.spyOn(LiveSessions.prototype, 'hasAwaitingInput').mockImplementation(() => mockHasAwaiting())
    await registry.evict(SLUG)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    await registry.evict(SLUG)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  /** Let the alarm's timeout read land (it is a settings read), without moving the clock. */
  const settle = () => vi.advanceTimersByTimeAsync(0)

  async function startRuntime() {
    const runtime = agents.runtime(SLUG)
    await runtime.ensureRunning()
    expect(runtime.getCachedInfo().status).toBe('running')
    await settle()
    return runtime
  }

  it('a start arms the alarm, and the alarm stops the container one timeout later without force-stopping', async () => {
    // Not a multiple of the watch's 5-minute status pass: in this test's instant time, a status
    // read begun in the same millisecond as the sleep would land after the stop and show it running.
    settings.app.autoSleepTimeoutMinutes = 29
    const runtime = await startRuntime()
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    expect(runtime.idleSince()).toBe(T0)

    await vi.advanceTimersByTimeAsync(29 * MINUTE - 1)
    expect(mockStop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(mockStop.mock.calls[0][0]).toMatchObject({ escalateToForceStop: false, stopTimeoutMs: 60_000, killTimeoutMs: 30_000 })
    expect(runtime.getCachedInfo().status).toBe('stopped')
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    expect(runtime.idleSince()).toBeNull()
  })

  it('a keep-alive and a session write each push the sleep back', async () => {
    const runtime = await startRuntime()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    runtime.keepAlive()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    runtime.noteSessionActivity()
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(mockStop).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('leaves a busy container alone and sleeps it once its sessions are quiet', async () => {
    const runtime = await startRuntime()
    mockHasActive.mockReturnValue(true)
    expect(runtime.idleSince()).toBeNull()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).not.toHaveBeenCalled()
    expect(alarmOf(SLUG).isArmed()).toBe(true)

    mockHasActive.mockReturnValue(false)
    mockHasAwaiting.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()

    mockHasAwaiting.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('never sleeps while auto-sleep is disabled', async () => {
    settings.app.autoSleepTimeoutMinutes = 0
    await startRuntime()
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(3 * TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('a shortened timeout applies when the alarm next wakes: nothing re-arms a running container', async () => {
    await startRuntime()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    settings.app.autoSleepTimeoutMinutes = 5
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1)
    expect(mockStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('auto-sleep turned on while a container runs is picked up by its next status check', async () => {
    settings.app.autoSleepTimeoutMinutes = 0
    await startRuntime()
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    settings.app.autoSleepTimeoutMinutes = 30
    await settle()
    expect(alarmOf(SLUG).isArmed()).toBe(false)

    // The watch's status pass, 5 minutes after the start, finds the container running and arms the alarm.
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT - 5 * MINUTE)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('session writes and keep-alives read no setting and move no timer', async () => {
    const runtime = await startRuntime()
    readSettings.mockClear()
    const timers = vi.getTimerCount()
    for (let i = 0; i < 10; i++) {
      runtime.noteSessionActivity()
      runtime.keepAlive()
    }
    await settle()
    expect(readSettings).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(timers)
    // The wake-up reads it before deciding (busy then: it waits another full timeout).
    mockHasActive.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(readSettings).toHaveBeenCalledTimes(1)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('a lengthened timeout applies when the alarm next wakes: it waits out the rest', async () => {
    await startRuntime()
    // The alarm wakes on the old deadline, reads the new timeout, and waits out the rest.
    settings.app.autoSleepTimeoutMinutes = 60
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TIMEOUT)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('retries when the stop did not complete, and gives up once the container is gone', async () => {
    mockStop.mockResolvedValueOnce({ forceStopUsed: false, stopped: false })
    const runtime = await startRuntime()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
    // Still running: the alarm is armed for a retry, not forgotten.
    expect(runtime.getCachedInfo().status).toBe('running')
    expect(alarmOf(SLUG).isArmed()).toBe(true)

    await vi.advanceTimersByTimeAsync(MINUTE)
    expect(mockStop).toHaveBeenCalledTimes(2)
    expect(runtime.getCachedInfo().status).toBe('stopped')
    expect(alarmOf(SLUG).isArmed()).toBe(false)
  })

  it('a session write to a stopped agent marks the clock but arms nothing, and the next start is unaffected', async () => {
    // The actor's first read finds the container stopped.
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })
    const runtime = agents.runtime(SLUG)
    await actorOf(SLUG).firstRead
    // Deleting a message or appending to a transcript offline records activity.
    runtime.noteSessionActivity()
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    expect(runtime.idleSince()).toBeNull()
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()

    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    await runtime.ensureRunning()
    await settle()
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('a stale mark during an in-flight start does not sleep the container the start brings up', async () => {
    let finishStart!: (info: { status: 'running'; port: number }) => void
    mockStart.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve }))
    const runtime = agents.runtime(SLUG)
    const starting = runtime.ensureRunning()
    await vi.advanceTimersByTimeAsync(0)
    expect(runtime.isStarting()).toBe(true)

    runtime.noteSessionActivity(T0 - TIMEOUT - MINUTE)
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    await alarmOf(SLUG).fire()
    expect(mockStop).not.toHaveBeenCalled()

    finishStart({ status: 'running', port: 4001 })
    await starting
    await settle()
    expect(runtime.getCachedInfo().status).toBe('running')
    // The start is the newest mark: a full window from now, not the stale one.
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT - 1)
    expect(mockStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('re-arms when a status sync sees the container running again after reporting it stopped', async () => {
    const runtime = await startRuntime()
    // A transient inspect failure (or a real external stop) is reported as stopped:
    // the alarm is disarmed, and one that fires in that window finds nothing to sleep.
    // The actor's status checks in the window read it as stopped too.
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })
    await runtime.syncAgentStatus()
    expect(runtime.getCachedInfo().status).toBe('stopped')
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    await alarmOf(SLUG).fire()
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).not.toHaveBeenCalled()

    // The next sync sees it running: the clock was never reset, so the alarm
    // counts from the original start mark, which is already past the timeout,
    // and sleeps the container as soon as its timeout read lands.
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })
    await runtime.syncAgentStatus()
    expect(runtime.getCachedInfo().status).toBe('running')
    await vi.advanceTimersByTimeAsync(0)
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(runtime.getCachedInfo().status).toBe('stopped')
  })

  it('the actor\'s status check reads a container shown as stopped again, and sleeps it once idle', async () => {
    const runtime = await startRuntime()
    mockGetInfoFromRuntime.mockResolvedValueOnce({ status: 'stopped', port: null })
    await runtime.syncAgentStatus()
    expect(alarmOf(SLUG).isArmed()).toBe(false)

    // The watch's status pass, 5 minutes after the start, sees the container running and re-arms the alarm.
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(runtime.getCachedInfo().status).toBe('running')
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT - 5 * MINUTE + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('reads the container of a start that failed again, and sleeps one the start left running', async () => {
    // The first read finds nothing running, and the next pass confirms it: the actor stops reading.
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })
    mockIsDefinitelyStopped.mockResolvedValue(true)
    await actorOf(SLUG).firstRead
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(actorOf(SLUG).state.containerWatch.isWatching()).toBe(false)

    // The start gives up, and its container comes up anyway.
    mockStart.mockRejectedValueOnce(new Error('the container did not become ready in time'))
    await expect(agents.runtime(SLUG).ensureRunning()).rejects.toThrow('did not become ready')
    expect(actorOf(SLUG).state.containerWatch.isWatching()).toBe(true)
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'running', port: 4001 })

    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(agents.runtime(SLUG).getCachedInfo().status).toBe('running')
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('a stopped read that lands after the agent was evicted leaves its watch stopped', async () => {
    mockGetInfoFromRuntime.mockResolvedValue({ status: 'stopped', port: null })
    await actorOf(SLUG).firstRead
    const watch = actorOf(SLUG).state.containerWatch

    // The next pass's read is in flight when the agent is evicted, and the runner cannot confirm the stop.
    let answer!: (info: { status: 'stopped'; port: null }) => void
    mockGetInfoFromRuntime.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(mockGetInfoFromRuntime).toHaveBeenCalledTimes(2)
    await registry.evict(SLUG)
    answer({ status: 'stopped', port: null })
    await settle()

    expect(watch.isWatching()).toBe(false)
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(mockGetInfoFromRuntime).toHaveBeenCalledTimes(2)
  })

  it('a container a sync finds running gets an alarm, though no actor was held for it', async () => {
    // As after a restart: the runtime exists, nothing has asked for the agent's actor yet.
    await agents.runtime(SLUG).syncAgentStatus()
    await settle()
    expect(alarmOf(SLUG).isArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(TIMEOUT + 1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it('a periodic sync that keeps seeing the container running does not push the alarm out', async () => {
    const runtime = await startRuntime()
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    await runtime.syncAgentStatus()
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1)
    expect(mockStop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })

  it("the actor's checkIdle() decides now: it waits while the container was active within the timeout, and sleeps it once it was not", async () => {
    await startRuntime()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    await actorOf(SLUG).checkIdle()
    expect(mockStop).not.toHaveBeenCalled()
    expect(alarmOf(SLUG).isArmed()).toBe(true)

    vi.setSystemTime(T0 + TIMEOUT)
    await actorOf(SLUG).checkIdle()
    expect(mockStop).toHaveBeenCalledTimes(1)
    expect(alarmOf(SLUG).isArmed()).toBe(false)
  })

  it('dropping the runtime disarms the alarm, and so does evicting the actor', async () => {
    await startRuntime()
    agents.drop(SLUG)
    expect(alarmOf(SLUG).isArmed()).toBe(false)
    await startRuntime()
    const alarm = alarmOf(SLUG)
    expect(alarm.isArmed()).toBe(true)
    await registry.evict(SLUG)
    expect(alarm.isArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(2 * TIMEOUT)
    expect(mockStop).not.toHaveBeenCalled()
  })
})
