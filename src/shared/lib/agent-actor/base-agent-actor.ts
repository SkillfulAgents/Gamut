import pLimit from 'p-limit'
import { readSessionToolHistory } from '@shared/lib/services/session-tool-history'
import type { ContainerHost } from '@shared/lib/container/container-host'
import { autoSleepTimeoutMsFrom } from '@shared/lib/container/idle-alarm'
import { getSettings } from '@shared/lib/config/settings'
import type { ContainerRuntime } from '@shared/lib/container/container-runtime'
import { ANY_APPLICATION_LEVEL } from '@shared/lib/computer-use/types'
import * as sessionService from '@shared/lib/services/session-service'
import { appendAssistantEntry } from '@shared/lib/services/session-transcript-append'
import { recordSessionActivity } from '@shared/lib/services/session-activity'
import * as transcripts from './local-transcript-ops'
import { syncAgentConnectionEnvironment } from '@shared/lib/container/connection-runtime-sync'
import { loadDailyUsageData, loadSessionUsageTotals } from '@shared/lib/services/usage-service'
import { scanArtifactsIn } from '@shared/lib/services/artifact-scan'
import type { HostPort } from './host-port'
import { runComputerUse, runScript } from './host-runs'
import type { SessionsRuntime } from './live/live-sessions'
import type { SessionEvent } from './live/session-channel'
import { SubagentCapture } from '@shared/lib/container/subagent-capture'
import { background } from '@shared/lib/background'
import { createMemoryOps } from './memory-ops'
import { matchesTranscriptQuery } from './transcript-query'
import { findDeliveredFile, readTranscriptView } from '@shared/lib/services/x-agent-transcript-view'
import { createSessionDelivery, notAcceptedError, type SessionDelivery } from './delivery'
import { MessageNotAcceptedError } from '@shared/lib/container/message-dispatch-error'
import { createAgentState, releaseAgentState, releaseSessionState, settleStoppedSession, type AgentState, type AgentStateHooks } from './agent-state'
import { exportSessionMetadata, ingestSessionMetadataFile } from '@shared/lib/services/session-metadata-file'
import { transcriptPath, type SessionStore } from './session-store'
import { readSessionContext } from './session-context'
import { sessionEvents, sessionFrames } from './session-streams'
import type { UserInputRequestOutcome } from '@shared/lib/tools/requests/request-schema'
import type {
  AccountReauthOps,
  AgentActor,
  AgentListing,
  AgentLiveSummary,
  AgentSlug,
  ComputerUseOps,
  ConfigOps,
  ContainerOps,
  FileOps,
  InputOps,
  LockOps,
  McpReauthOps,
  McpSessionOps,
  MessageOps,
  MemoryOps,
  ReviewOps,
  SessionOps,
  UsageOps,
  VolumeUploadOps,
  WidgetOps,
} from './types'

/**
 * What an actor is given: the two things outside the agent that it cannot
 * make for itself. Everything else it uses is its own code, which it imports.
 */
export interface AgentActorParts {
  /** The container layer. The actor asks it for its own container runtime, which the actor then holds. */
  readonly containers: Pick<ContainerHost, 'createRuntime'>
  /** The host this agent asks for host tools, machine work and side effects. */
  readonly host: HostPort
}

// Dev-only capture of the sessions' frames for fixture replays: one per
// process, so offsets and snapshot numbers compare across agents.
const subagentCapture = SubagentCapture.fromEnv()

/**
 * How many of this process's agents read their listing from disk at a time.
 * The agent list asks every agent at once; the actors of one process share
 * its disk and its thread pool, so the bound is theirs to keep. An actor
 * alone in its process is never held back by it.
 */
const listingLimit = pLimit(5)

/**
 * An agent's actor: everything `AgentActor` does, for an agent whose
 * container and sessions this object holds. A subclass says where the agent
 * is kept: where its files are, what wakes it to check whether its container
 * is idle, and how what it stored is deleted (`LocalAgentActor`: a directory
 * on this machine, the app database, and a timer of this process).
 *
 * Runtime methods delegate with the agent's store or slug, or with the
 * actor's own stores where the state is the actor's. Storage capabilities
 * such as memories compose operations over this actor's files. The ops are
 * closures rather than class methods so a caller may destructure them
 * (`const { send } = actor.messages`).
 */
export abstract class BaseAgentActor implements AgentActor {
  readonly live: () => Promise<AgentLiveSummary>
  readonly listing: () => Promise<AgentListing>
  readonly ready: () => Promise<void>
  readonly container: ContainerOps
  readonly sessions: SessionOps
  readonly messages: MessageOps
  readonly inputs: InputOps
  readonly usage: UsageOps
  readonly files: FileOps
  readonly memories: MemoryOps
  readonly config: ConfigOps
  readonly locks: LockOps
  readonly widgets: WidgetOps
  readonly mcpSessions: McpSessionOps
  readonly volumeUploads: VolumeUploadOps
  /** Where this agent's sessions are: the files, the config documents, the transcripts directory. */
  readonly store: SessionStore
  /**
   * What this agent holds in memory: its live sessions, its pending
   * user-input requests, the reviews and re-auth waits parked on them, its
   * computer-use grants. Created with the actor and released by `dispose`.
   */
  readonly state: AgentState
  /**
   * The actor's first read of its container, begun when the actor is made:
   * until it lands, the actor does not know whether its container runs. An
   * actor that takes up state an earlier one made has nothing to read.
   */
  readonly firstRead: Promise<void>

  /**
   * `survivingStates` is for a process whose backend modules are re-evaluated
   * while it runs (the dev server, on an edit): the actor keeps its state in
   * the map, and an actor made later for the slug takes that state up rather
   * than start with none. What the agent holds (live sessions, parked reviews
   * and waits, open requests, grants) then outlives the code that made it.
   * Desktop and the Node server pass none.
   */
  constructor(
    readonly slug: AgentSlug,
    /** Kept for a subclass: `createSessionStore` runs while the actor is being made, before the subclass has set anything of its own. */
    protected readonly parts: AgentActorParts,
    private readonly survivingStates?: Map<AgentSlug, AgentState>,
  ) {
    const { containers, host } = parts
    // Every write to a session goes through the store, so this is where the
    // container's idle clock learns of session activity — the live sessions'
    // stream frames, the transcript appends and `sessions.recordActivity`
    // all record through it.
    const runtime = () => this.state.runtime()
    const survived = survivingStates?.get(slug)
    this.state =
      survived ??
      createAgentState(slug, {
        sessions: {
          store: this.createSessionStore({
            onActivity: (at) => runtime().noteSessionActivity(at),
          }),
          host,
          runtime: createSessionsRuntime(slug, runtime),
          capture: subagentCapture,
        },
        idle: {
          // The setting, read by the actor itself at every decision.
          timeoutMs: async () => autoSleepTimeoutMsFrom(await getSettings()),
          lastActivityAt: () => runtime().sleepableSince(),
          sleep: (timeoutMs) => runtime().sleepIdle(timeoutMs),
          wakeAt: (at) => this.wakeToCheckIdleAt(at),
          cancelWake: () => this.cancelIdleWake(),
        },
        watch: createContainerWatchHooks(slug, () => this.state),
        runtime: (agent) => containers.createRuntime(slug, agent),
      })
    survivingStates?.set(slug, this.state)
    this.firstRead = survived ? Promise.resolve() : this.state.containerWatch.readNow()
    this.ready = () => this.firstRead
    this.store = this.state.store
    this.files = this.store.files
    this.memories = createMemoryOps(this.store.files)
    this.config = this.store.config
    this.live = async () => liveSummary(slug, this.state)
    this.container = createContainerOps(slug, runtime)
    const delivery = createSessionDelivery(slug, this.store, this.state.sessions, runtime, {
      sessionService,
      // Read at call time, as the session service's functions are.
      recordSessionActivity: (...args) => recordSessionActivity(...args),
      denyReviews: (sessionId) => this.state.reviews.denyAll(sessionId),
      host,
    })
    this.sessions = createSessionOps(slug, this.store, this.state, delivery, host)
    this.messages = createMessageOps(slug, this.store, this.state, delivery)
    this.inputs = createInputOps(slug, this.state, host)
    this.usage = createUsageOps(this.store)
    this.locks = createLockOps(this.state)
    this.widgets = createWidgetOps(this.state)
    this.mcpSessions = createMcpSessionOps(this.state)
    this.volumeUploads = createVolumeUploadOps(this.state)
    this.listing = () => listingLimit(async () => {
      const [sessions, artifacts] = await Promise.all([
        this.sessions.summary(),
        scanArtifactsIn(this.files, { includeWidgets: true, agentSlug: slug }),
      ])
      // What is in memory is read after the disk, so it is never older than
      // the files beside it: a refresh that ended during the scan left its new
      // snapshot in `artifacts`, and must not still read as in flight.
      const [live, refreshingWidgets] = await Promise.all([this.live(), this.widgets.refreshing()])
      return { live, sessions, artifacts, refreshingWidgets }
    })
  }

  /**
   * Decides whether the container sleeps now: what this actor's idle wake-up
   * runs when it goes off. The idle alarm sleeps the container, or sets the
   * next wake-up.
   */
  checkIdle(): Promise<void> {
    return this.state.idleAlarm.fire()
  }

  /**
   * Where this agent's files, config documents and transcripts are. Called
   * once, while the actor is being made: it may use `slug` and `parts`, and
   * nothing a subclass sets in its own constructor.
   */
  protected abstract createSessionStore(hooks: Pick<SessionStore, 'onActivity'>): SessionStore

  /** Has `checkIdle()` run at `at` (epoch ms), in place of any wake-up set before. */
  protected abstract wakeToCheckIdleAt(at: number): void

  /** Drops the wake-up `wakeToCheckIdleAt` set, if any. */
  protected abstract cancelIdleWake(): void

  /** Removes everything this agent stored (see `AgentActor.delete`). */
  abstract delete(): Promise<void>

  /** The registry is dropping this actor: release everything it holds (see `AgentActor.dispose`). */
  async dispose(reason?: 'shutdown'): Promise<void> {
    // Released before the first await: a caller that drops many actors relies
    // on each having let go by the time it has called them all.
    releaseAgentState(this.state)
    if (this.survivingStates?.get(this.slug) === this.state) this.survivingStates.delete(this.slug)
    if (reason !== 'shutdown') return
    // Activity the index recorded and has not stored yet: its wake-up does
    // not come once dispatch has stopped, and nothing reads the index again.
    await this.store.index.storeRecordedActivity().catch((error: unknown) => {
      console.warn(`[AgentActor] Could not store the recorded session activity of ${this.slug}:`, error)
    })
  }
}

/**
 * What the agent's container watch checks: the agent's container runtime. A
 * failed check is logged, and the next pass runs as usual. The status check
 * ends once the runner confirms the container stopped (`isDefinitelyStopped`):
 * a read that failed reads as stopped too, so until then it is read again. The
 * actor's first read only reads: startup waits for every agent's first read,
 * so the next pass confirms a stop. A start turns the checks back on.
 */
function createContainerWatchHooks(slug: AgentSlug, self: () => AgentState): AgentStateHooks['watch'] {
  let firstRead = true
  return {
    checkHealth: async () => {
      try {
        await self().runtime().runHealthCheck()
      } catch (error) {
        console.error(`[ContainerWatch] Health check failed for ${slug}:`, error)
      }
    },
    checkStatus: async () => {
      const state = self()
      const runtime = state.runtime()
      const confirmsStop = !firstRead
      firstRead = false
      // A stop in flight sets the status itself.
      if (runtime.isStopping()) return
      const info = await runtime.syncAgentStatus().catch((error: unknown) => {
        console.error(`[ContainerWatch] Failed to sync status for ${slug}:`, error)
        runtime.markAsStopped()
        return null
      })
      // Dropped during the read (the agent evicted): asking it for a client would make one and restart the watch.
      if (state.peekRuntime() !== runtime) return
      if (!info || info.status === 'running' || !confirmsStop) return
      const confirmed = await runtime.getClient().then((client) => client.isDefinitelyStopped()).catch(() => false)
      // Reading was an await: a start may have begun meanwhile, and it turns the checks back on.
      if (confirmed && !runtime.isStarting() && runtime.getCachedInfo().status !== 'running') state.containerWatch.stop()
    },
  }
}

function liveSummary(slug: AgentSlug, state: AgentState): AgentLiveSummary {
  const runtime = state.runtime()
  return {
    container: {
      ...runtime.getCachedInfo(),
      healthWarnings: runtime.getHealthWarnings(),
      stale: runtime.isStale(),
      idleSince: runtime.idleSince(),
    },
    activeSessionIds: state.sessions.activeIds(),
    awaitingSessionIds: state.sessions.awaitingIds(),
    openRequests: state.inputRequests.getOpenRequests().map(({ id, kind, blocking, autoApproved, scope }) => ({
      id, kind, blocking, autoApproved, ...(scope.sessionId !== undefined ? { sessionId: scope.sessionId } : {}),
    })),
    pendingReviews: state.reviews.pending().map(({ id, displayText }) => ({ id, displayText })),
  }
}

function createContainerOps(slug: AgentSlug, runtime: () => ContainerRuntime): ContainerOps {
  const client = () => runtime().getClient()
  return {
    start: async () => {
      await runtime().ensureRunning()
    },
    stop: (...args) => runtime().stopContainer(...args),
    keepAlive: async () => runtime().keepAlive(),
    status: async () => runtime().getCachedInfo(),
    invalidate: async (options) => {
      if (!runtime().holdsDrives()) return 'not-running'
      // A start in flight is not torn down: it comes up stale instead.
      if (!options?.restart || runtime().isStarting()) {
        runtime().markStale()
        return 'marked-stale'
      }
      await runtime().restartContainer()
      return 'restarted'
    },
    holdsDrives: async (options) => runtime().holdsDrives() || (!!options?.orStarting && runtime().isStarting()),
    info: async () => (await client()).getInfo(),
    syncConnectionEnvironment: (kind, options) => syncAgentConnectionEnvironment(slug, kind, runtime(), options),
    fetch: async (...args) => (await client()).fetch(...args),
    webSocketTarget: async (path, init) => {
      const info = runtime().getCachedInfo()
      if (info.status !== 'running' || !info.port) return null
      const c = await client()
      return {
        url: `${c.getWebSocketBaseUrl(info.port)}${path}${init?.search ?? ''}`,
        ...(init?.protocols !== undefined ? { protocols: init.protocols } : {}),
        headers: { ...init?.headers, ...(await c.getHostAuthHeaders()) },
      }
    },
    hostBridgeIp: async () => (await client()).getHostBridgeIp(),
    probeHostPort: async (host, port) => (await client()).probeHostPortFromRunner(host, port),
  }
}

function createSessionOps(
  slug: AgentSlug,
  store: SessionStore,
  state: AgentState,
  delivery: SessionDelivery,
  host: HostPort,
): SessionOps {
  const client = async () => state.runtime().getClient()
  const live = state.sessions
  // The container's CLI process rewrites the transcript on exit, so the container drops the session before the files go.
  const release = async (sessionId: string) => {
    // Settle the calls parked on the session's own cards before the stream drops them.
    releaseSessionState(state, sessionId)
    const running = live.isActive(sessionId)
    // The stream lets go first, so an append in flight cannot write the transcript again after it is gone.
    live.unsubscribe(sessionId)
    state.deferredNaming.delete(sessionId)
    let cause: unknown
    const dropped =
      (await client().then((container) => container.releaseSession(sessionId)).catch((error: unknown) => {
        cause = error
        return false
      })) || (await client().then((container) => container.isDefinitelyStopped()).catch(() => false))
    if (!dropped) console.warn(`[sessions.delete] container kept ${sessionId}:`, cause)
    // Its turn ended with its process: its viewers and the global feed hear so, as after a stop.
    else if (running) live.markInterrupted(sessionId)
    return dropped
  }
  const forget = async (sessionId: string) => {
    live.endStreams(sessionId)
    // The files are gone. A lost cleanup response must not turn a successful
    // delete into a failure; the container refuses to resume a released
    // record whose transcript is absent, including after a container restart.
    await client().then((container) => container.deleteSession(sessionId)).catch((error: unknown) => {
      console.warn(`[sessions.delete] could not forget ${sessionId}:`, error)
    })
  }
  return {
    list: (...args) => sessionService.listSessions(store, ...args),
    listByIds: (...args) => sessionService.listSessionsByIds(store, ...args),
    get: (...args) => sessionService.getSession(store, ...args),
    getWithMetadata: (sessionId) => sessionService.getSessionWithMetadata(store, sessionId),
    summary: () => sessionService.getSessionSummary(store),
    exists: (sessionId) => sessionService.sessionExists(store, sessionId),
    isKnown: (sessionId) => sessionService.sessionIsKnown(store, sessionId),
    isRegistered: (sessionId) => sessionService.isSessionRegistered(store, sessionId),
    register: (...args) => sessionService.registerSession(store, ...args),
    rename: async (sessionId, name) => {
      await sessionService.updateSessionName(store, sessionId, name)
      live.emit(sessionId, { type: 'session_updated' })
      host.send('global', { type: 'session_updated', sessionId, agentSlug: slug })
    },
    delete: (sessionId) => live.inDeliveryTurn(sessionId, async () => {
      if (!(await release(sessionId))) throw new Error(`Container did not drop session ${sessionId}`)
      const deleted = await sessionService.deleteSession(store, sessionId)
      await forget(sessionId)
      return deleted
    }),
    // Activity is checked right before each release, since the ones before it wait on the container.
    deleteMany: async (sessionIds) => {
      const deleted: string[] = []
      for (const sessionId of sessionIds) {
        // Keep the send queue held through the file delete. Releasing every
        // process first would let a send resume an earlier session while a
        // later container request is still pending.
        await live.inDeliveryTurn(sessionId, async () => {
          if (live.isActive(sessionId) || !(await release(sessionId))) return
          const removed = await sessionService.deleteSessionsBatch(store, [sessionId])
          if (removed.length === 0) return
          deleted.push(...removed)
          await forget(sessionId)
        })
      }
      return deleted
    },
    metadata: (sessionId) => sessionService.getSessionMetadata(store, sessionId),
    readMetadata: () => sessionService.readSessionMetadata(store),
    exportMetadata: () => exportSessionMetadata(store),
    ingestMetadataFile: () => ingestSessionMetadataFile(store),
    recordInvocation: (sessionId, invocation) => store.index.update(sessionId, current => {
      if (!current) return null
      const previous = current.meta?.invokedSessions ?? []
      return { ...current.meta, invokedSessions: [
        ...previous.filter(call => call.sessionId !== invocation.sessionId || call.agentSlug !== invocation.agentSlug),
        invocation,
      ] }
    }),
    updateMetadata: (sessionId, updates) => sessionService.updateSessionMetadata(store, sessionId, updates),
    fileRealPathWithinAgent: (sessionId) => sessionService.sessionFileRealPathWithinAgent(store, sessionId),
    usage: (sessionId) =>
      loadSessionUsageTotals({ files: store.files, transcript: transcriptPath(store, sessionId) }),
    byScheduledTask: (taskId) => sessionService.getSessionsByScheduledTask(store, taskId),
    byWebhookTrigger: (triggerId) => sessionService.getSessionsByWebhookTrigger(store, triggerId),
    forScheduledExecution: (taskId, executionAt) =>
      sessionService.getSessionForScheduledExecution(store, taskId, executionAt),
    recordActivity: async (...args) => recordSessionActivity(store, ...args),
    recordRuntime: async (sessionId, runtime) => live.recordRuntime(sessionId, runtime),

    subagents: (sessionId, options) => transcripts.listSubagents(store, sessionId, options),
    subagentTranscript: (sessionId, subagentId) => transcripts.readSubagentTranscript(store, sessionId, subagentId),
    workflowTree: (sessionId, runId) => transcripts.readWorkflowTree(store, sessionId, runId),
    workflowAgentTranscript: (sessionId, runId, workflowAgentId) =>
      transcripts.readWorkflowAgentTranscript(store, sessionId, runId, workflowAgentId),
    copyDerivedFiles: (sourceId, targetId) => transcripts.copyDerivedSessionFiles(store, sourceId, targetId),

    // Creating a session delivers its first message: a refusal reads as a delivery's does.
    create: async (options) =>
      (await client()).createSession(options).catch((error: unknown) => {
        throw error instanceof MessageNotAcceptedError ? notAcceptedError(error) : error
      }),
    start: (request) => delivery.start(request),
    fork: async (sessionId) => (await client()).forkSession(sessionId),
    deleteLive: async (sessionId) => (await client()).deleteSession(sessionId),
    warm: async (sessionId) => (await client()).warmSession(sessionId),

    live: async (sessionId) => ({
      activity: live.activity(sessionId),
      isActive: live.isActive(sessionId),
      isAwaitingInput: live.isAwaitingInput(sessionId),
      streamAttached: live.isSubscribed(sessionId),
      openRequests: state.inputRequests.getOpenRequestsForSession(sessionId),
      runtime: live.runtime(sessionId) ?? null,
    }),
    markActive: async (sessionId) => live.markActive(sessionId),
    markIdle: async (sessionId) => {
      // Going idle is the last moment the session was busy.
      state.runtime().noteSessionActivity()
      live.markIdle(sessionId)
    },
    stopTask: async (sessionId, taskId) => (await client()).stopTask(sessionId, taskId),
    contextBreakdown: (sessionId, refresh) => readSessionContext(store, sessionId, refresh, async () => {
      if (state.runtime().getCachedInfo().status !== 'running') return { breakdown: null }
      return (await client()).getContextBreakdown(sessionId)
    }),
    waitForIdle: (sessionId, opts) => live.waitForIdle(sessionId, opts),
    broadcastUpdate: async (sessionId) => live.emit(sessionId, { type: 'session_updated' }),
    reconcileTranscript: async (sessionId, toolCalls) => live.reconcileTranscript(sessionId, toolCalls),
    promoteAutomated: (sessionId, metadata) => live.promoteAutomated(sessionId, metadata),
    grantCapability: async (sessionId, capability) => live.grantCapability(sessionId, capability),

    attach: (sessionId, options) => delivery.attach(sessionId, options),

    deferNaming: async (sessionId) => {
      state.deferredNaming.add(sessionId)
    },
    takeDeferredNaming: async (sessionId) => state.deferredNaming.delete(sessionId),
  }
}

function createMessageOps(
  slug: AgentSlug,
  store: SessionStore,
  state: AgentState,
  delivery: SessionDelivery,
): MessageOps {
  const client = async () => state.runtime().getClient()
  const live = state.sessions
  return {
    deliver: (request) => delivery.deliver(request),
    // A message held while the session recovers never reached the container.
    cancelQueued: async (sessionId, uuid) => live.dropCoalesced(sessionId, uuid) || (await client()).cancelQueuedMessage(sessionId, uuid),
    stop: async (sessionId, options) => {
      const result = await delivery.stop(sessionId, options)
      if (options.denyReviews && result.path !== 'skipped-idle') settleStoppedSession(state, sessionId)
      return result
    },

    withCompact: (sessionId) => sessionService.getSessionMessagesWithCompact(store, sessionId),
    toolHistory: (sessionId, names) =>
      readSessionToolHistory(sessionService.streamSessionMessagesWithCompact(store, sessionId), names),
    transcriptView: (sessionId, opts) =>
      readTranscriptView(sessionService.streamSessionMessagesWithCompact(store, sessionId), opts),
    findDeliveredFile: (sessionId, deliveryId) =>
      findDeliveredFile(sessionService.streamSessionMessagesWithCompact(store, sessionId), deliveryId),
    page: (sessionId, opts) => sessionService.getSessionMessagesPage(store, sessionId, opts),
    delta: (sessionId, opts) => sessionService.getSessionMessagesDelta(store, sessionId, opts),
    findLastEntry: (sessionId, query, options) =>
      sessionService.findLastSessionEntry(store, sessionId, matchesTranscriptQuery(query), options),
    remove: (sessionId, messageUuid) => sessionService.removeMessage(store, sessionId, messageUuid),
    removeToolCall: (sessionId, toolCallId) => sessionService.removeToolCall(store, sessionId, toolCallId),
    appendAssistant: (sessionId, text) => appendAssistantEntry(store, sessionId, text),
    forkedUserUuids: (sessionId) => transcripts.forkedUserUuids(store, sessionId),
    rawLog: (sessionId) => transcripts.openRawLog(store, sessionId),
    media: (...args) => transcripts.openMedia(store, ...args),

    subscribe: async (sessionId) => sessionEvents(live, sessionId),
    follow: (sessionId, { after }) => sessionFrames(live, sessionId, after),
    broadcastEvent: async (sessionId, data) => live.emit(sessionId, data as SessionEvent),
  }
}

function createInputOps(slug: AgentSlug, state: AgentState, host: HostPort): InputOps {
  const requests = state.inputRequests
  // A settled request may have been what a session waited on.
  const resolve = (id: string, outcome: UserInputRequestOutcome) => {
    const resolved = requests.resolve(id, outcome)
    state.sessions.syncAwaiting()
    return resolved
  }
  return {
    register: async (input, options) =>
      options?.unlessRecentlyResolved && input.id && requests.getRecentResolution(input.id) ? null : requests.register(input),
    get: async (id) => requests.getOpenRequest(id),
    claim: async (id, options) => requests.claimRequest(id, options?.leaseMs),
    releaseClaim: async (id, token) => requests.releaseClaim(id, token),
    answer: (id, value) => answerRequest(state, id, value),
    resolve: async (id, outcome) => resolve(id, outcome),
    recentResolution: async (id) => requests.getRecentResolution(id),
    snapshot: async (sessionId) => requests.getSnapshotForScope(sessionId),
    enrich: async (id, kind, enrichment) => requests.enrichOpenRequestPayload(id, kind, enrichment),

    complete: async (sessionId, toolUseId, outcome) => state.sessions.completeRequest(sessionId, toolUseId, outcome),
    completeCapabilityReview: async (sessionId, toolUseId, outcome) =>
      state.sessions.completeCapabilityReview(sessionId, toolUseId, outcome),
    cancelAwaiting: (sessionId) => state.sessions.cancelAwaitingInput(sessionId),

    reviews: createReviewOps(state),
    computerUse: createComputerUseOps(state, host),
    mcpReauth: createMcpReauthOps(state, resolve),
    accountReauth: createAccountReauthOps(state, resolve),
  }
}

/** `inputs.answer`: one decision's whole run, holding the request's claim (see `InputOps.answer`). */
async function answerRequest(state: AgentState, id: string, value: unknown): ReturnType<InputOps['answer']> {
  const requests = state.inputRequests
  if (!requests.getOpenRequest(id)) return 'not-open'
  const claim = requests.claimRequest(id)
  if (!claim) return 'claimed'
  try {
    const runtime = state.runtime()
    await runtime.ensureRunning()
    // A decision on another surface settles the request without the claim.
    // Settled while the container started, the container has nothing parked:
    // answering now would buffer a result nothing ever collects.
    if (!requests.getOpenRequest(id)) return 'not-open'
    const response = await (await runtime.getClient()).fetch(`/inputs/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    })
    if (!response.ok) {
      console.error(`[AgentActor] The container would not take the answer to ${id}: ${response.status} ${await response.text().catch(() => '')}`)
      return 'undeliverable'
    }
    state.sessions.completeRequest(undefined, id, 'answered')
    return 'answered'
  } finally {
    // Settling dropped the claim with the request; this matters only to a run that did not settle it.
    requests.releaseClaim(id, claim.token)
  }
}

// The review and re-auth ops read and write the stores the actor holds: they
// are created with the actor and released with it.

function createReviewOps(state: AgentState): ReviewOps {
  const reviews = state.reviews
  return {
    get: async (id) => reviews.pending().find((review) => review.id === id) ?? null,
    submit: async (id, decision, detail) => reviews.submit(id, decision, detail),
    resolveMatching: async (scope, decision) => reviews.resolveMatching(scope, decision),
    resolveMatchingByLabel: async (label, decision) => reviews.resolveMatchingByLabel(label, decision),
    resolveMatchingXAgent: async (operation, decision) => reviews.resolveMatchingXAgent(operation, decision),
    request: (details, options) => reviews.request(details, options),
    requestXAgent: (request, options) => reviews.requestXAgent(request, options),
    withdraw: async (id) => reviews.withdraw(id),
    resume: (id) => reviews.resume(id),
    settle: (id, decision) => reviews.settle(id, decision),
    takeDecisionDetail: (id) => reviews.takeDecisionDetail(id),
  }
}

function createComputerUseOps(state: AgentState, host: HostPort): ComputerUseOps {
  const computerUse = state.computerUse
  return {
    releaseApp: async (sessionId) => {
      const appName = computerUse.activeApp(sessionId)
      computerUse.clearActiveApp(sessionId)
      if (appName) await computerUse.revoke('use_application', appName)
      // Taking the app back ends the any-app grants too, the agent's and the
      // session's: its next app asks again.
      await computerUse.revoke(ANY_APPLICATION_LEVEL)
      computerUse.revokeSession(sessionId)
      state.sessions.emit(sessionId, { type: 'computer_use_app_changed', app: null })
      return { appName }
    },
    setActiveApp: async (sessionId, appName) => computerUse.setActiveApp(sessionId, appName),
    clearActiveApp: async (sessionId) => computerUse.clearActiveApp(sessionId),
    grant: async (...args) => computerUse.grant(...args),
    consumeOnce: async (...args) => computerUse.consumeOnce(...args),
    revokeAll: async () => computerUse.revokeAll(),
    clearPending: async (...args) => state.sessions.clearComputerUseRequest(...args),
    run: (run) => runComputerUse(state.hostRuns, host, run),
    runScript: (run) => runScript(state.hostRuns, host, run),
  }
}

/** The agent's container runtime, as its live sessions reach it. */
function createSessionsRuntime(slug: AgentSlug, runtime: () => ContainerRuntime): SessionsRuntime {
  return {
    client: () => runtime().getClient(),
    fatalResult: (client, kind) => runtime().fatalResult(client, kind),
    unexpectedDeath: (sessionId) => runtime().handleUnexpectedDeath(sessionId ? [sessionId] : undefined),
    stopAfterFatalError: () => {
      console.log(`[AgentActor] Stopping container for ${slug} after a fatal error`)
      background(
        runtime()
          .stopContainer({ afterFatalError: true })
          .catch((err) => console.error(`[AgentActor] Failed to stop container for ${slug}:`, err)),
        { name: 'agent-actor.stop-after-fatal-error' },
      )
    },
  }
}

function createLockOps(state: AgentState): LockOps {
  const locks = state.locks
  return {
    tryAcquire: async (key) => locks.tryAcquire(key),
    acquire: (key) => locks.acquire(key),
    release: async (key, token) => locks.release(key, token),
  }
}

function createWidgetOps(state: AgentState): WidgetOps {
  const refreshes = state.widgetRefreshes
  return {
    beginRefresh: async (widgetSlug) => refreshes.begin(widgetSlug),
    beginOrJoinRefresh: (widgetSlug) => refreshes.beginOrJoin(widgetSlug),
    finishRefresh: async (widgetSlug, token, outcome) => refreshes.finish(widgetSlug, token, outcome),
    refreshing: async () => refreshes.refreshing(),
    refreshedAt: async () => refreshes.refreshedAt(),
    claimStaleSweep: async (throttleMs) => refreshes.claimStaleSweep(throttleMs),
    notePostRun: async () => refreshes.notePostRun(),
    isLatestPostRun: async (stamp) => refreshes.isLatestPostRun(stamp),
  }
}

function createMcpSessionOps(state: AgentState): McpSessionOps {
  const sessions = state.mcpSessions
  return {
    open: async (mcpId, protocolVersion) => sessions.open(mcpId, protocolVersion),
    get: async (mcpId, id) => sessions.get(mcpId, id),
    bind: async (id, upstreamSessionId) => sessions.bind(id, upstreamSessionId),
    unbind: async (id, upstreamSessionId) => sessions.unbind(id, upstreamSessionId),
    close: async (id) => sessions.close(id),
  }
}

function createVolumeUploadOps(state: AgentState): VolumeUploadOps {
  const uploads = state.volumeUploads
  return {
    begin: async (key) => uploads.begin(key),
    end: async (key, upload, outcome) => uploads.end(key, upload, outcome),
    allowDelete: async (key) => uploads.allowDelete(key),
  }
}

function createUsageOps(store: SessionStore): UsageOps {
  return {
    daily: (options) => loadDailyUsageData({ files: store.files, dir: store.transcriptsDir, ...options }),
  }
}

type ResolveRequest = (id: string, outcome: UserInputRequestOutcome) => unknown

function createMcpReauthOps(state: AgentState, resolve: ResolveRequest): McpReauthOps {
  const waits = state.mcpReauth
  return {
    request: (details, options) => waits.request(details, options),
    withdraw: async (waitId) => waits.withdraw(waitId),
    dismiss: async (entryId, ...rest) => waits.dismiss(entryId, ...rest),
    settleReplaced: async (entryId, replacementMcpId) => {
      if (waits.replace(entryId, replacementMcpId)) return 'released'
      resolve(entryId, 'answered')
      return 'resolved'
    },
    completeConnection: async (mcpId) => waits.complete(mcpId),
  }
}

function createAccountReauthOps(state: AgentState, resolve: ResolveRequest): AccountReauthOps {
  const waits = state.accountReauth
  return {
    request: (details, options) => waits.request(details, options),
    withdraw: async (waitId) => waits.withdraw(waitId),
    dismiss: async (entryId, ...rest) => waits.dismiss(entryId, ...rest),
    settleReplaced: async (entryId, replacementAccountId) => {
      if (waits.replace(entryId, replacementAccountId)) return 'released'
      resolve(entryId, 'answered')
      return 'resolved'
    },
    completeAccount: async (accountId) => waits.complete(accountId),
  }
}
