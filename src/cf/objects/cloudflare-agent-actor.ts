/**
 * An agent's actor on Cloudflare. `CloudflareAgentActor` is what every isolate holds for an agent:
 * a thin shim over the agent's own AgentDurableObject, which is where the agent runs. Each op is
 * one `actorCall` over Durable Object RPC on that object, which runs it on the actor the object
 * holds (`CloudflareAgentActorDO`, through `runActorOp`). Values cross as RPC clones them (dates,
 * maps, bytes, byte streams, requests and responses); errors cross through the actor error codec,
 * so callers still branch on their class. RPC carries only byte streams, so the ops that return a
 * stream of objects send it as JSON lines.
 *
 * No async context crosses RPC. In one process the actor's op runs inside the API request that
 * made it: the request's user is who the op acts for, and the request's settings read is shared.
 * Here the caller's user travels with the call, and the object runs the op as one operation of
 * that user (`runActorOp`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AgentDurableObject } from './cloudflare-agent'
import { callOnCurrentCode, type Checked, type Restarting } from '../lib/object-version'
import type { Env } from '../index'
import { heldObjectActor } from './object-actors'
import { decodeActorError, encodeActorError, type ActorErrorData } from '@shared/lib/agent-actor/actor-error-codec'
import {
  ACTOR_GROUPS,
  type AgentActor,
  type AgentSlug,
  type ConfigOps,
  type ContainerOps,
  type FileOps,
  type InputOps,
  type LockOps,
  type McpSessionOps,
  type MemoryOps,
  type MessageOps,
  type SessionOps,
  type UsageOps,
  type VolumeUploadOps,
  type WidgetOps,
} from '@shared/lib/agent-actor/types'
import { runWithSettingsMemo } from '@shared/lib/config/settings-request-memo'
import { getRequestUserId, runWithOptionalUser } from '@shared/lib/platform-attribution/request-context'

export type ActorOutcome = { value: unknown } | { error: ActorErrorData }

/** The agent object's RPC method this module calls. */
export interface ActorObject {
  /**
   * With the caller's version, the object checks its own code first (object-version.ts).
   * `actingUserId`: the user the caller's request or run acts for, when it has one.
   */
  actorCall(path: string, args: unknown[], callerVersion?: string, actingUserId?: string): Promise<ActorOutcome | Restarting | Checked<ActorOutcome>>
}

/** One call on the agent's object, given the version to send if the object is not checked yet. */
type ObjectCall = (agent: ActorObject, callerVersion?: string) => Promise<ActorOutcome | Restarting | Checked<ActorOutcome>>

/** Groups inside groups; everything else on a group is an op. */
const NESTED_GROUPS: Record<string, readonly string[]> = {
  inputs: ['reviews', 'computerUse', 'mcpReauth', 'accountReauth'],
}
const OP_SEGMENT = /^[a-zA-Z][a-zA-Z0-9]*$/
/** The actor's own calls, outside any group, that run where the agent runs. `dispose` is about what this isolate holds, and never crosses. */
type ActorCall = Exclude<{ [K in keyof AgentActor]: AgentActor[K] extends (...args: never[]) => unknown ? K : never }[keyof AgentActor], 'dispose'>
// Every one of them: a call added to AgentActor and not named here fails the type check.
const ACTOR_CALLS: Record<ActorCall, true> = { live: true, listing: true, ready: true, delete: true }
const isActorCall = (path: string): path is ActorCall => Object.hasOwn(ACTOR_CALLS, path)
const CONTAINER_FETCH = 'container.fetch'
// The ops whose result is a stream of objects (a viewer's frames, the app's session events).
const OBJECT_STREAM_OPS = new Set(['messages.follow', 'messages.subscribe'])

/** A stream of JSON values as a byte stream of JSON lines, which RPC can carry. */
function toJsonLines(values: ReadableStream<unknown>): ReadableStream<Uint8Array> {
  const reader = values.getReader()
  const encoder = new TextEncoder()
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

/** The values of a JSON-lines byte stream. */
function fromJsonLines(bytes: ReadableStream<Uint8Array>): ReadableStream<unknown> {
  let buffered = ''
  return bytes.pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>).pipeThrough(new TransformStream<string, unknown>({
    transform(text, controller) {
      const lines = (buffered + text).split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) if (line) controller.enqueue(JSON.parse(line))
    },
    flush(controller) {
      if (buffered) controller.enqueue(JSON.parse(buffered))
    },
  }))
}

// An AbortSignal does not cross RPC. The reads that take one use it only as advice;
// `container.fetch`'s is its caller's timeout, which the shim keeps on its own side (`unlessAborted`).
function withoutSignal(arg: unknown): unknown {
  if (arg instanceof AbortSignal) return undefined
  if (!arg || typeof arg !== 'object' || Object.getPrototypeOf(arg) !== Object.prototype) return arg
  return Object.fromEntries(Object.entries(arg).filter(([, value]) => !(value instanceof AbortSignal)))
}

/**
 * Every op of an actor by its path: `live`, `sessions.list`, `inputs.reviews.withdraw`. `dispose`
 * is not one: it is about what this isolate holds, and never crosses.
 */
type OpPath<T> = { [K in keyof T & string]: T[K] extends (...args: never[]) => unknown ? K : T[K] extends object ? `${K}.${OpPath<T[K]>}` : never }[keyof T & string]
type ActorOpPath = OpPath<Omit<AgentActor, 'slug' | 'dispose'>>
/** The op at a path. */
type OpAt<T, P extends string> = P extends `${infer K}.${infer Rest}` ? (K extends keyof T ? OpAt<T[K], Rest> : never) : P extends keyof T ? T[P] : never

/**
 * The agent's actor in every isolate: the entry point registers it as the actor its agents run as
 * (`initializeAgentRegistry((slug) => new CloudflareAgentActor(slug, env))`). It is a thin shim
 * and holds nothing of the agent. Every op below is one call to the agent's own object, reached
 * through `env.AGENT` on the code `env.VERSION` names, which runs it on the actor the object
 * holds. Inside that object a call goes straight to that actor, with no call to itself. Chosen at
 * each call, not once: an isolate can serve the agent's object and other callers. A new stub is
 * made for each call: a Worker request may not use a stub another request made.
 *
 * Every op is written out, under its own path. One that is added to `AgentActor` and not added
 * here, or is given another op's path with another signature, fails the type check.
 */
export class CloudflareAgentActor implements AgentActor {
  readonly slug: AgentSlug
  private readonly env: Pick<Env, 'AGENT' | 'VERSION'>

  constructor(slug: AgentSlug, env: Pick<Env, 'AGENT' | 'VERSION'>) {
    this.slug = slug
    this.env = env
  }

  readonly live = this.rpc('live')
  readonly listing = this.rpc('listing')
  readonly ready = this.rpc('ready')
  readonly delete = this.rpc('delete')

  /**
   * The registry is dropping this actor. It holds nothing of the agent, so there is nothing to
   * let go of: the agent's own actor is its object's, and outlives whoever asked for the agent
   * from here. An isolate that shuts its services down (a replaced task manager) drops its
   * shims, and must not take the agents whose objects share the isolate down with them. Never
   * an RPC.
   */
  dispose(_reason?: 'shutdown'): Promise<void> {
    return Promise.resolve()
  }

  readonly container: ContainerOps = {
    start: this.rpc('container.start'),
    stop: this.rpc('container.stop'),
    keepAlive: this.rpc('container.keepAlive'),
    status: this.rpc('container.status'),
    invalidate: this.rpc('container.invalidate'),
    holdsDrives: this.rpc('container.holdsDrives'),
    info: this.rpc('container.info'),
    syncConnectionEnvironment: this.rpc('container.syncConnectionEnvironment'),
    fetch: this.rpc('container.fetch'),
    webSocketTarget: this.rpc('container.webSocketTarget'),
    hostBridgeIp: this.rpc('container.hostBridgeIp'),
    probeHostPort: this.rpc('container.probeHostPort'),
  }
  readonly sessions: SessionOps = {
    list: this.rpc('sessions.list'),
    listByIds: this.rpc('sessions.listByIds'),
    get: this.rpc('sessions.get'),
    getWithMetadata: this.rpc('sessions.getWithMetadata'),
    summary: this.rpc('sessions.summary'),
    exists: this.rpc('sessions.exists'),
    isKnown: this.rpc('sessions.isKnown'),
    isRegistered: this.rpc('sessions.isRegistered'),
    register: this.rpc('sessions.register'),
    rename: this.rpc('sessions.rename'),
    delete: this.rpc('sessions.delete'),
    deleteMany: this.rpc('sessions.deleteMany'),
    metadata: this.rpc('sessions.metadata'),
    readMetadata: this.rpc('sessions.readMetadata'),
    exportMetadata: this.rpc('sessions.exportMetadata'),
    ingestMetadataFile: this.rpc('sessions.ingestMetadataFile'),
    recordInvocation: this.rpc('sessions.recordInvocation'),
    updateMetadata: this.rpc('sessions.updateMetadata'),
    fileRealPathWithinAgent: this.rpc('sessions.fileRealPathWithinAgent'),
    usage: this.rpc('sessions.usage'),
    byScheduledTask: this.rpc('sessions.byScheduledTask'),
    byWebhookTrigger: this.rpc('sessions.byWebhookTrigger'),
    forScheduledExecution: this.rpc('sessions.forScheduledExecution'),
    recordActivity: this.rpc('sessions.recordActivity'),
    recordRuntime: this.rpc('sessions.recordRuntime'),
    subagents: this.rpc('sessions.subagents'),
    subagentTranscript: this.rpc('sessions.subagentTranscript'),
    workflowTree: this.rpc('sessions.workflowTree'),
    workflowAgentTranscript: this.rpc('sessions.workflowAgentTranscript'),
    copyDerivedFiles: this.rpc('sessions.copyDerivedFiles'),
    create: this.rpc('sessions.create'),
    start: this.rpc('sessions.start'),
    fork: this.rpc('sessions.fork'),
    deleteLive: this.rpc('sessions.deleteLive'),
    warm: this.rpc('sessions.warm'),
    live: this.rpc('sessions.live'),
    markActive: this.rpc('sessions.markActive'),
    markIdle: this.rpc('sessions.markIdle'),
    stopTask: this.rpc('sessions.stopTask'),
    contextBreakdown: this.rpc('sessions.contextBreakdown'),
    waitForIdle: this.rpc('sessions.waitForIdle'),
    broadcastUpdate: this.rpc('sessions.broadcastUpdate'),
    reconcileTranscript: this.rpc('sessions.reconcileTranscript'),
    promoteAutomated: this.rpc('sessions.promoteAutomated'),
    grantCapability: this.rpc('sessions.grantCapability'),
    attach: this.rpc('sessions.attach'),
    deferNaming: this.rpc('sessions.deferNaming'),
    takeDeferredNaming: this.rpc('sessions.takeDeferredNaming'),
  }
  readonly messages: MessageOps = {
    deliver: this.rpc('messages.deliver'),
    cancelQueued: this.rpc('messages.cancelQueued'),
    stop: this.rpc('messages.stop'),
    withCompact: this.rpc('messages.withCompact'),
    toolHistory: this.rpc('messages.toolHistory'),
    transcriptView: this.rpc('messages.transcriptView'),
    findDeliveredFile: this.rpc('messages.findDeliveredFile'),
    page: this.rpc('messages.page'),
    delta: this.rpc('messages.delta'),
    findLastEntry: this.rpc('messages.findLastEntry'),
    remove: this.rpc('messages.remove'),
    removeToolCall: this.rpc('messages.removeToolCall'),
    appendAssistant: this.rpc('messages.appendAssistant'),
    forkedUserUuids: this.rpc('messages.forkedUserUuids'),
    rawLog: this.rpc('messages.rawLog'),
    media: this.rpc('messages.media'),
    subscribe: this.rpc('messages.subscribe'),
    follow: this.rpc('messages.follow'),
    broadcastEvent: this.rpc('messages.broadcastEvent'),
  }
  readonly inputs: InputOps = {
    register: this.rpc('inputs.register'),
    get: this.rpc('inputs.get'),
    claim: this.rpc('inputs.claim'),
    releaseClaim: this.rpc('inputs.releaseClaim'),
    answer: this.rpc('inputs.answer'),
    resolve: this.rpc('inputs.resolve'),
    recentResolution: this.rpc('inputs.recentResolution'),
    snapshot: this.rpc('inputs.snapshot'),
    enrich: this.rpc('inputs.enrich'),
    complete: this.rpc('inputs.complete'),
    completeCapabilityReview: this.rpc('inputs.completeCapabilityReview'),
    cancelAwaiting: this.rpc('inputs.cancelAwaiting'),
    reviews: {
      get: this.rpc('inputs.reviews.get'),
      submit: this.rpc('inputs.reviews.submit'),
      resolveMatching: this.rpc('inputs.reviews.resolveMatching'),
      resolveMatchingByLabel: this.rpc('inputs.reviews.resolveMatchingByLabel'),
      resolveMatchingXAgent: this.rpc('inputs.reviews.resolveMatchingXAgent'),
      request: this.rpc('inputs.reviews.request'),
      requestXAgent: this.rpc('inputs.reviews.requestXAgent'),
      withdraw: this.rpc('inputs.reviews.withdraw'),
      resume: this.rpc('inputs.reviews.resume'),
      settle: this.rpc('inputs.reviews.settle'),
      takeDecisionDetail: this.rpc('inputs.reviews.takeDecisionDetail'),
      allowForSession: this.rpc('inputs.reviews.allowForSession'),
      sessionAllows: this.rpc('inputs.reviews.sessionAllows'),
    },
    computerUse: {
      releaseApp: this.rpc('inputs.computerUse.releaseApp'),
      setActiveApp: this.rpc('inputs.computerUse.setActiveApp'),
      clearActiveApp: this.rpc('inputs.computerUse.clearActiveApp'),
      grant: this.rpc('inputs.computerUse.grant'),
      consumeOnce: this.rpc('inputs.computerUse.consumeOnce'),
      revokeAll: this.rpc('inputs.computerUse.revokeAll'),
      clearPending: this.rpc('inputs.computerUse.clearPending'),
      run: this.rpc('inputs.computerUse.run'),
      runScript: this.rpc('inputs.computerUse.runScript'),
    },
    mcpReauth: {
      request: this.rpc('inputs.mcpReauth.request'),
      withdraw: this.rpc('inputs.mcpReauth.withdraw'),
      dismiss: this.rpc('inputs.mcpReauth.dismiss'),
      settleReplaced: this.rpc('inputs.mcpReauth.settleReplaced'),
      completeConnection: this.rpc('inputs.mcpReauth.completeConnection'),
    },
    accountReauth: {
      request: this.rpc('inputs.accountReauth.request'),
      withdraw: this.rpc('inputs.accountReauth.withdraw'),
      dismiss: this.rpc('inputs.accountReauth.dismiss'),
      settleReplaced: this.rpc('inputs.accountReauth.settleReplaced'),
      completeAccount: this.rpc('inputs.accountReauth.completeAccount'),
    },
  }
  readonly usage: UsageOps = {
    daily: this.rpc('usage.daily'),
  }
  readonly files: FileOps = {
    list: this.rpc('files.list'),
    stat: this.rpc('files.stat'),
    resolve: this.rpc('files.resolve'),
    read: this.rpc('files.read'),
    getDoc: this.rpc('files.getDoc'),
    putDoc: this.rpc('files.putDoc'),
    write: this.rpc('files.write'),
    delete: this.rpc('files.delete'),
    mkdir: this.rpc('files.mkdir'),
    append: this.rpc('files.append'),
    readSized: this.rpc('files.readSized'),
  }
  readonly memories: MemoryOps = {
    list: this.rpc('memories.list'),
    read: this.rpc('memories.read'),
    save: this.rpc('memories.save'),
  }
  readonly config: ConfigOps = {
    get: this.rpc('config.get'),
    read: this.rpc('config.read'),
    put: this.rpc('config.put'),
  }
  readonly locks: LockOps = {
    tryAcquire: this.rpc('locks.tryAcquire'),
    acquire: this.rpc('locks.acquire'),
    release: this.rpc('locks.release'),
  }
  readonly widgets: WidgetOps = {
    beginRefresh: this.rpc('widgets.beginRefresh'),
    beginOrJoinRefresh: this.rpc('widgets.beginOrJoinRefresh'),
    finishRefresh: this.rpc('widgets.finishRefresh'),
    refreshing: this.rpc('widgets.refreshing'),
    refreshedAt: this.rpc('widgets.refreshedAt'),
    claimStaleSweep: this.rpc('widgets.claimStaleSweep'),
    notePostRun: this.rpc('widgets.notePostRun'),
    isLatestPostRun: this.rpc('widgets.isLatestPostRun'),
  }
  readonly mcpSessions: McpSessionOps = {
    open: this.rpc('mcpSessions.open'),
    get: this.rpc('mcpSessions.get'),
    bind: this.rpc('mcpSessions.bind'),
    unbind: this.rpc('mcpSessions.unbind'),
    close: this.rpc('mcpSessions.close'),
  }
  readonly volumeUploads: VolumeUploadOps = {
    begin: this.rpc('volumeUploads.begin'),
    end: this.rpc('volumeUploads.end'),
    allowDelete: this.rpc('volumeUploads.allowDelete'),
  }

  /** The op at `path`, as a call to the agent's object. */
  private rpc<P extends ActorOpPath>(path: P): OpAt<AgentActor, P> {
    return ((...args: unknown[]) => this.call(path, args)) as unknown as OpAt<AgentActor, P>
  }

  private async call(path: string, args: unknown[]): Promise<unknown> {
    const local = servingAgentObject(this.slug) ? heldObjectActor(this.slug) : undefined
    if (local) return runOnActor(local, path, args)
    // Read here, in the caller's own context: `reach` may run the call later, and the object never sees this context.
    const actingUserId = getRequestUserId()
    const signal = path === CONTAINER_FETCH ? (args[1] as RequestInit | undefined)?.signal : undefined
    signal?.throwIfAborted()
    const sent = path === CONTAINER_FETCH ? fetchArgs(args) : args.map(withoutSignal)
    const outcome = await unlessAborted(this.reach((agent, callerVersion) => agent.actorCall(path, sent, callerVersion, actingUserId)), signal)
    if ('error' in outcome) throw decodeActorError(outcome.error)
    return OBJECT_STREAM_OPS.has(path) ? fromJsonLines(outcome.value as ReadableStream<Uint8Array>) : outcome.value
  }

  /** The agent's object: this one when it is serving the current request, its stub otherwise. */
  private async reach(run: ObjectCall): Promise<ActorOutcome> {
    const own = servingAgentObject(this.slug)
    if (own) return (await run(own)) as ActorOutcome
    return callOnCurrentCode(this.env.AGENT, this.slug, this.env.VERSION?.timestamp, (agent, callerVersion) => run(agent, callerVersion))
  }
}

/**
 * The object's answer, unless `signal` fires first: then the call rejects with the signal's
 * reason, as an aborted fetch does, and its caller stops waiting. The object goes on with the
 * request, since no signal reaches it; a response that arrives after that is discarded.
 */
function unlessAborted(answered: Promise<ActorOutcome>, signal?: AbortSignal | null): Promise<ActorOutcome> {
  if (!signal) return answered
  return new Promise<ActorOutcome>((resolve, reject) => {
    const stopWaiting = () => {
      reject(signal.reason)
      answered.then((outcome) => {
        if ('value' in outcome && outcome.value instanceof Response) void outcome.value.body?.cancel().catch(() => {})
      }, () => {})
    }
    signal.addEventListener('abort', stopWaiting, { once: true })
    answered.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopWaiting))
  })
}

/** `container.fetch`'s arguments as they cross RPC: the request without its signal. */
function fetchArgs([path, init]: unknown[]): unknown[] {
  return [path, init && new Request('http://container', { ...(init as RequestInit), signal: undefined })]
}

/** One call on the actor in this isolate, as it was made: no clone, no codec. */
async function runOnActor(actor: AgentActor, path: string, args: unknown[]): Promise<unknown> {
  if (path === CONTAINER_FETCH) return actor.container.fetch(...(args as Parameters<AgentActor['container']['fetch']>))
  const op = lookupOp(actor, path)
  if (!op) throw new TypeError(`No actor op ${path}`)
  return op.fn.apply(op.owner, args)
}

/**
 * Runs one op from `CloudflareAgentActor` on the actor in this object, as an API request runs:
 * the op's settings readers share one read, and what the op does for a user (platform calls,
 * access checks) is done for `actingUserId`. With no user, the op resolves one as a background
 * job does.
 */
export function runActorOp(actor: AgentActor, path: string, args: unknown[], actingUserId?: string): Promise<ActorOutcome> {
  return runWithSettingsMemo(async () => runWithOptionalUser(actingUserId, () => runOp(actor, path, args)))
}

async function runOp(actor: AgentActor, path: string, args: unknown[]): Promise<ActorOutcome> {
  try {
    if (path === CONTAINER_FETCH) {
      const [target, request] = args as [string, Request | undefined]
      return { value: await actor.container.fetch(target, request && initOf(request)) }
    }
    const op = lookupOp(actor, path)
    if (!op) throw new TypeError(`No actor op ${path}`)
    const value = await op.fn.apply(op.owner, args)
    return { value: OBJECT_STREAM_OPS.has(path) ? toJsonLines(value as ReadableStream<unknown>) : value }
  } catch (error) {
    return { error: encodeActorError(error) }
  }
}

function initOf(request: Request): RequestInit {
  return { method: request.method, headers: request.headers, ...(request.body ? { body: request.body, duplex: 'half' } : {}) } as RequestInit
}

// Only a function on an actor group: no prototype keys, no `constructor`.
function lookupOp(actor: AgentActor, path: string): { owner: object; fn: (...args: unknown[]) => unknown } | null {
  const segments = path.split('.')
  if (segments.some((segment) => !OP_SEGMENT.test(segment) || segment === 'constructor')) return null
  if (isActorCall(path)) return { owner: actor, fn: actor[path] as (...args: unknown[]) => unknown }
  const [group, ...rest] = segments
  if (!(ACTOR_GROUPS as readonly string[]).includes(group) || rest.length === 0 || rest.length > 2) return null
  if (rest.length === 2 && !(NESTED_GROUPS[group] ?? []).includes(rest[0])) return null
  let owner: unknown = actor[group as (typeof ACTOR_GROUPS)[number]]
  for (const segment of rest.slice(0, -1)) owner = (owner as Record<string, unknown> | undefined)?.[segment]
  const fn = (owner as Record<string, unknown> | undefined)?.[rest[rest.length - 1]]
  return typeof fn === 'function' && owner ? { owner: owner as object, fn: fn as (...args: unknown[]) => unknown } : null
}

/*
 * Which agent's object serves the current request in this isolate. Cloudflare can run several
 * Durable Objects of one class in one isolate, and SuperAgent's module state is shared by all of
 * them, while each object's storage may be touched only from that object's own requests. So an
 * agent's object is called directly only inside its own request, and through its stub otherwise.
 */
const serving = new AsyncLocalStorage<{ slug: AgentSlug; object: AgentDurableObject }>()

/** Runs `work` as the agent's own object: what it starts there (background work too) stays its own. */
export function runAsAgentObject<T>(slug: AgentSlug, object: AgentDurableObject, work: () => T): T {
  return serving.run({ slug, object }, work)
}

/** The agent's object when it is the one serving the current request; null otherwise. */
export function servingAgentObject(slug: AgentSlug): AgentDurableObject | null {
  const current = serving.getStore()
  return current?.slug === slug ? current.object : null
}
