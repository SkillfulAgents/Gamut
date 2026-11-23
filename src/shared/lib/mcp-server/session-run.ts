/**
 * Running an agent for an MCP client: deliver a prompt (or answer the
 * question a session waits on), then wait a bounded time for the session to
 * settle, and describe where it stands in the one shape `invoke_agent`,
 * `ask_team_brain` and `wait_for_session` return.
 *
 * The wait is the client's, never the session's: the call returns within
 * `MAX_WAIT_SECONDS` (Codex and ChatGPT cut a tool call at 60s), a client that
 * cancels or disconnects only ends its own wait, and the session runs on.
 * While waiting, a progress notification goes out every few seconds when the
 * client asked for progress.
 *
 * Delivery goes through the x-agent service with a user caller, so the
 * person's own `agent_acl` role decides (user or higher to invoke) and the
 * session is started automated, hidden until promoted, with `mcpInvocation`
 * provenance.
 */
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import { background } from '@shared/lib/background'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { getTeamBrain } from '@shared/lib/config/settings'
import { resolveAppLinkContext, withSessionUrl } from '@shared/lib/agent-integrations/app-link'
import { callerHasRoleOnTarget, userXAgentCaller } from '@shared/lib/services/x-agent/caller'
import { invokeAgent } from '@shared/lib/services/x-agent/invoke'
import type { XAgentFailure } from '@shared/lib/services/x-agent/operations'
import { compactMessage } from '@shared/lib/services/x-agent-transcript-view'
import { resolveSignedUpload, takeSignedUpload } from '@shared/lib/signed-file-urls/signed-file-urls'
import { isReplayableUserInputRequest, type PendingUserInputRequest } from '@shared/lib/tools/requests/request-schema'
import type { AgentRole } from '@shared/lib/types/agent'
import { appendAttachedFiles } from '@shared/lib/utils/attached-files'
import { displaySlug } from '@shared/lib/utils/file-storage'
import type { McpCallContext } from './context'
import type { McpToolCall } from './tool-definition'
import { McpToolError, truncateText } from './tool-result'

/** How long a call waits when the client does not say. */
export const DEFAULT_WAIT_SECONDS = 45
/** The longest a call waits: under the 60-second tool limit of Codex and ChatGPT, with room for the reply. */
export const MAX_WAIT_SECONDS = 50
/** How often a waiting call reports progress. */
export const PROGRESS_INTERVAL_MS = 5_000
/** How often a waiting call looks at the session. */
const POLL_SLICE_MS = 1_000
/** The most characters of the agent's last message a result carries. */
const LAST_MESSAGE_MAX_CHARS = 20_000
/** The most attachments one invoke takes. */
export const MAX_ATTACHMENTS = 10
/** A settled turn's reply can reach the transcript a moment after the session goes idle. */
const REPLY_FLUSH_ATTEMPTS = 10
const REPLY_FLUSH_INTERVAL_MS = 300

export type RunStatus = 'running' | 'completed' | 'awaiting_input' | 'failed'

export interface PendingRequest {
  kind: string
  text: string
  open_in_gamut_url: string
}

export interface RunResult {
  [key: string]: unknown
  agent: string
  session_id: string
  status: RunStatus
  last_message: string | null
  delivered_files: Array<{ delivery_id: string; filename: string; size_bytes: number }>
  pending_request: PendingRequest | null
  note?: string
}

/** The wait a call runs with, in seconds: the client's, clamped to [0, MAX]; absent or not a number, the default. */
export function clampWaitSeconds(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WAIT_SECONDS
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, requested))
}

interface Target {
  slug: string
  display: string
  name: string
}

function failureError(failure: XAgentFailure, minRole: AgentRole): McpToolError {
  if (failure.status === 404 && failure.error === 'Target agent not found') return agentNotFound()
  if (failure.status === 404 && failure.error === 'Session not found') return sessionNotFound()
  if (failure.status === 403 && failure.error.startsWith('Forbidden')) return noRole(minRole)
  return new McpToolError(failure.error)
}

function agentNotFound(): McpToolError {
  return new McpToolError('Agent not found. Call list_agents for the agents you can use, and pass a slug exactly as it gives it.')
}

function sessionNotFound(): McpToolError {
  return new McpToolError('Session not found for this agent. Call list_sessions with the same agent for its session ids, or leave out session_id to start a new session.')
}

function noRole(minRole: AgentRole): McpToolError {
  return minRole === 'viewer'
    ? new McpToolError('You do not have access to this agent: this needs at least the viewer role. Ask an owner of the agent to share it with you.')
    : new McpToolError('You cannot run this agent: invoking it needs the user role or higher, and you have less. Ask an owner of the agent to give you the user role.')
}

/** The agent, once the person holds `minRole` on it; "not found" for an agent they cannot see at all. */
export async function resolveTarget(ctx: McpCallContext, ref: string, minRole: AgentRole): Promise<Target> {
  const record = await agentCatalog.resolveRecord(ref)
  if (!record) throw agentNotFound()
  const caller = userXAgentCaller({ userId: ctx.userId, isAdmin: ctx.isAdmin })
  if (!(await callerHasRoleOnTarget(caller, record.slug, minRole))) {
    // Someone with no role at all is told nothing about the agent.
    if (minRole !== 'viewer' && (await callerHasRoleOnTarget(caller, record.slug, 'viewer'))) throw noRole(minRole)
    throw agentNotFound()
  }
  return { slug: record.slug, display: displaySlug(record.name, record.slug), name: record.name }
}

/** Where the person opens the session: the desktop app's deep link, else the web app. */
export async function sessionLink(ctx: McpCallContext, slug: string, sessionId: string): Promise<string> {
  if (process.type === 'browser') {
    const link = withSessionUrl(await resolveAppLinkContext(slug), sessionId)
    if (link?.url) return link.url
  }
  return `${ctx.publicBaseUrl}/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}`
}

/** What the person is asked, in one line or a few. */
function requestText(request: PendingUserInputRequest): string {
  const payload = request.payload as Record<string, unknown>
  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : undefined)
  const withReason = (text: string) => (str('reason') ? `${text}: ${str('reason')}` : text)
  switch (request.kind) {
    case 'question': {
      const questions = Array.isArray(payload.questions) ? payload.questions as Array<Record<string, unknown>> : []
      const lines = questions.map((question) => {
        const options = Array.isArray(question.options)
          ? (question.options as Array<Record<string, unknown>>).map((option) => option.label).filter((label): label is string => typeof label === 'string')
          : []
        const text = typeof question.question === 'string' ? question.question : ''
        return options.length > 0 ? `${text} (options: ${options.join(', ')})` : text
      }).filter(Boolean)
      return lines.join('\n') || 'The agent asked a question.'
    }
    case 'secret': return withReason(`The agent needs the secret ${str('secretName') ?? ''}`.trim())
    case 'connected_account': return withReason(`The agent wants the person to connect their ${str('toolkit') ?? ''} account`.replace(/\s+/g, ' '))
    case 'file': return `The agent wants the person to upload a file${str('description') ? `: ${str('description')}` : ''}`
    case 'login': return str('message') ?? 'The agent needs the person to sign in to a website.'
    case 'browser_input': return str('message') ?? 'The agent needs the person to act in a browser session.'
    case 'computer_use': return `The agent wants to use ${str('appName') ?? 'the person\'s computer'}`
    case 'script_run': return `The agent wants approval to run a script${str('explanation') ? `: ${str('explanation')}` : ''}`
    case 'remote_mcp': return withReason(`The agent wants to connect a remote MCP server${str('name') ? ` (${str('name')})` : ''}`)
    case 'capability_review': return `The agent wants approval to ${str('capability') === 'workflows' ? 'run a workflow' : 'launch a subagent'}`
    case 'integration_setup': return withReason('The agent asked the person to set up an integration')
    default: return 'The agent is waiting on a decision from the person in Gamut.'
  }
}

/** The blocking requests the session waits on, the ones a person can see. */
function openBlocking(requests: PendingUserInputRequest[], sessionId: string): PendingUserInputRequest[] {
  return requests.filter((request) => request.blocking && !request.autoApproved && (request.scope.sessionId ?? sessionId) === sessionId)
}

/**
 * The one plain question the session waits on, when that is all it waits on:
 * one open request, a question, whose card asks one thing. The chat
 * integrations answer exactly this with a typed reply and nothing else
 * (`consumeOrCancelAwaitingInput` in resolve-awaiting-input.ts): a card with
 * several questions, or any other request, needs Gamut.
 */
function answerableQuestion(requests: PendingUserInputRequest[]): PendingUserInputRequest | null {
  if (requests.length !== 1) return null
  const [request] = requests
  if (request.kind !== 'question' || !isReplayableUserInputRequest(request)) return null
  const questions = Array.isArray(request.payload.questions) ? request.payload.questions as Array<Record<string, unknown>> : []
  return questions.length === 1 && typeof questions[0].question === 'string' ? request : null
}

/** The answer as the app sends it (`answer-question`): the question's text mapped to the answer. */
function answersFor(request: PendingUserInputRequest, answer: string): Record<string, string> {
  const [question] = request.payload.questions as Array<{ question: string }>
  return { [question.question]: answer }
}

interface LastAssistant {
  uuid: string
  /** The entry's own text, without tool-use placeholders; '' when it has none. */
  text: string
  isError: boolean
}

async function lastAssistant(slug: string, sessionId: string): Promise<LastAssistant | null> {
  const entry = await agentRegistry.get(slug).messages.findLastEntry(sessionId, { kind: 'assistant' })
  if (!entry || entry.type === 'system') return null
  const compact = compactMessage(entry)
  if (!compact) return null
  return { uuid: entry.uuid, text: compact.spoken, isError: entry.isApiErrorMessage === true }
}

/** The last assistant entry newer than `boundaryUuid`, polled briefly when the reply may still be flushing. */
async function replyAfter(slug: string, sessionId: string, boundaryUuid: string | undefined, settle: boolean): Promise<LastAssistant | null> {
  const attempts = settle ? REPLY_FLUSH_ATTEMPTS : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = await lastAssistant(slug, sessionId)
    if (last && last.uuid !== boundaryUuid) return last
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, REPLY_FLUSH_INTERVAL_MS))
  }
  return null
}

/** How many view rows a result reads: the current turn's prompt and what followed it. */
const TURN_VIEW_ROWS = 40

/**
 * The session's latest turn as a result reports it: the agent's last real
 * text since the last prompt (the spoken view: text only, never a tool-use
 * placeholder), or null when it has written none yet; and its delivered files.
 */
async function latestTurn(slug: string, sessionId: string): Promise<{ text: string | null; deliveredFiles: RunResult['delivered_files'] }> {
  const view = await agentRegistry.get(slug).messages.transcriptView(sessionId, { limit: TURN_VIEW_ROWS })
  let lastPrompt = -1
  view.messages.forEach((message, index) => { if (message.role === 'user') lastPrompt = index })
  const replies = view.messages.slice(lastPrompt + 1).filter((message) => message.role === 'assistant' && message.content.trim())
  const text = replies.at(-1)?.content ?? null
  return {
    text: text === null ? null : truncateText(text, LAST_MESSAGE_MAX_CHARS).text,
    deliveredFiles: view.deliveredFiles.map((file) => ({ delivery_id: file.deliveryId, filename: file.filename, size_bytes: file.sizeBytes })),
  }
}

type WaitOutcome = 'settled' | 'awaiting_input' | 'running'

/**
 * Wait for the session to settle (idle) or to wait on the person, until
 * `deadline` or the client goes away. Looks every second; nothing is left
 * behind when it returns (a look in flight ends within a second on its own).
 * Progress is the call's own clock (`withProgress`), not this loop's.
 *
 * `afterDelivery`: the wait follows a prompt (or an answer) this call
 * delivered. An idle session then counts as settled only once the turn is
 * known to have run: it was seen active or waiting on the person during this
 * wait, or an assistant entry newer than `boundaryUuid` exists. Delivery marks
 * the session active before it returns (`markSending` in delivery.ts, and
 * `markActive` right after create in its `start`), so this is a second guard,
 * for a delivery held rather than sent (a recovering session coalesces it) or
 * a mark something else undid.
 */
async function waitForSettle(
  slug: string,
  sessionId: string,
  deadline: number,
  call: McpToolCall,
  afterDelivery?: { boundaryUuid: string | undefined },
): Promise<WaitOutcome> {
  const sessions = agentRegistry.get(slug).sessions
  let onAbort = () => {}
  const abortedNow = new Promise<'aborted'>((resolve) => { onAbort = () => resolve('aborted') })
  if (call.signal.aborted) onAbort()
  call.signal.addEventListener('abort', onAbort, { once: true })
  let started = !afterDelivery
  try {
    for (;;) {
      const live = await sessions.live(sessionId)
      if (live.isAwaitingInput) return 'awaiting_input'
      if (live.isActive) {
        started = true
      } else {
        if (started) return 'settled'
        const last = await lastAssistant(slug, sessionId)
        if (last && last.uuid !== afterDelivery?.boundaryUuid) return 'settled'
        // Delivered, and the turn has not begun: keep waiting for it.
      }
      const remaining = deadline - Date.now()
      if (call.signal.aborted || remaining <= 0) return 'running'
      // One slice: the session going idle (or, not started yet, a pause), the
      // slice's end, or the client leaving. A slice that loses to an abort
      // ends by itself within a second.
      const slice = Math.min(remaining, POLL_SLICE_MS)
      await Promise.race([
        live.isActive
          ? sessions.waitForIdle(sessionId, { timeoutMs: slice }).catch(() => 'timeout' as const)
          : new Promise((resolve) => setTimeout(resolve, slice)),
        abortedNow,
      ])
    }
  } finally {
    call.signal.removeEventListener('abort', onAbort)
  }
}

const QUESTION_NOTE = 'The agent asked a question. Answer it by calling invoke_agent with this agent and session_id, and the answer as prompt. If you do not know the answer, ask the person you are working for; they can also answer in Gamut at open_in_gamut_url.'
const SEVERAL_QUESTIONS_NOTE = 'The agent asked several questions at once (pending_request.text lists them). Those are answered in Gamut, not through this server: give the person open_in_gamut_url, then call wait_for_session with this session_id.'
const IN_GAMUT_NOTE = 'The agent is waiting on the person, in Gamut: this cannot be done through this server. Give the person open_in_gamut_url; once they have dealt with it, call wait_for_session with this session_id.'

/**
 * Where the session stands now, in the result shape. `boundaryUuid`: the last
 * assistant entry before this call's prompt, so a settled turn's reply is the
 * one after it. `previousReplyCounts`: a wait on a turn already running, whose
 * reply may have landed before the wait began.
 */
async function describe(
  ctx: McpCallContext,
  target: Target,
  sessionId: string,
  outcome: WaitOutcome,
  boundaryUuid: string | undefined,
  options: { extraNote?: string; previousReplyCounts?: boolean } = {},
): Promise<RunResult> {
  const actor = agentRegistry.get(target.slug)

  if (outcome === 'awaiting_input') {
    const live = await actor.sessions.live(sessionId)
    const open = openBlocking(live.openRequests, sessionId)
    const question = answerableQuestion(open)
    const request = question ?? open.find((candidate) => candidate.kind !== 'question') ?? open[0]
    const turn = await latestTurn(target.slug, sessionId)
    const note = question ? QUESTION_NOTE : request?.kind === 'question' ? SEVERAL_QUESTIONS_NOTE : IN_GAMUT_NOTE
    return {
      agent: target.display,
      session_id: sessionId,
      delivered_files: turn.deliveredFiles,
      status: 'awaiting_input',
      last_message: turn.text,
      pending_request: {
        kind: request?.kind ?? 'unknown',
        text: request ? requestText(request) : 'The agent is waiting on the person in Gamut.',
        open_in_gamut_url: await sessionLink(ctx, target.slug, sessionId),
      },
      note: options.extraNote ? `${options.extraNote} ${note}` : note,
    }
  }

  if (outcome === 'running') {
    const turn = await latestTurn(target.slug, sessionId)
    return {
      agent: target.display,
      session_id: sessionId,
      delivered_files: turn.deliveredFiles,
      status: 'running',
      last_message: turn.text,
      pending_request: null,
      note: 'The agent is still working. Call wait_for_session with this agent and session_id to keep waiting. Do NOT call invoke_agent again for the same request: that would start a second run.',
    }
  }

  // Settled: the reply is an entry after the boundary (it may still be flushing).
  const reply = (await replyAfter(target.slug, sessionId, boundaryUuid, true))
    ?? (options.previousReplyCounts ? await lastAssistant(target.slug, sessionId) : null)
  const turn = await latestTurn(target.slug, sessionId)
  const failed = reply?.isError === true
  const text = !reply ? null : failed ? (reply.text || turn.text) : (turn.text ?? (reply.text || null))
  return {
    agent: target.display,
    session_id: sessionId,
    delivered_files: turn.deliveredFiles,
    status: failed ? 'failed' : 'completed',
    last_message: text === null ? null : truncateText(text, LAST_MESSAGE_MAX_CHARS).text,
    pending_request: null,
    ...(failed
      ? { note: 'The agent\'s turn ended with an error (last_message). You can retry by calling invoke_agent with this session_id.' }
      : reply ? {} : { note: 'The session is idle and wrote no new reply.' }),
  }
}

/**
 * The uploads named by `attachments`, each taken for one use, as workspace
 * paths for the prompt. All or nothing:
 * - a repeated id, or one that is not a finished upload of this person for
 *   this agent, is refused before any id is spent;
 * - when a take still fails (another call took that id between the check and
 *   the take), the ids this call already took are put back
 *   (`takeSignedUpload`'s `putBack`), so they stay attachable. An id that
 *   could not be put back (it expired meanwhile, or the store failed) is
 *   named in the error as used up, to be uploaded again.
 * Ids returned here are spent; a delivery that then fails says so
 * (`spentUploadsNote`).
 */
async function takeAttachments(ctx: McpCallContext, slug: string, uploadIds: string[]): Promise<string[]> {
  if (uploadIds.length === 0) return []
  if (uploadIds.length > MAX_ATTACHMENTS) throw new McpToolError(`At most ${MAX_ATTACHMENTS} attachments per call.`)
  const repeated = uploadIds.find((id, index) => uploadIds.indexOf(id) !== index)
  if (repeated !== undefined) {
    throw new McpToolError(`Attachment "${repeated}" appears more than once in attachments; each upload_id is attached once. Nothing was sent and no upload was used.`)
  }
  for (const id of uploadIds) {
    if (!(await resolveSignedUpload(ctx.userId, slug, id))) {
      throw new McpToolError(`Attachment "${id}" is not a finished upload for this agent: call prepare_file_upload with this agent, PUT the file to its upload_url, then pass its upload_id here. Each upload_id can be attached once.`)
    }
  }
  const taken: Array<{ id: string; path: string; putBack: () => Promise<boolean> }> = []
  for (const id of uploadIds) {
    const upload = await takeSignedUpload(ctx.userId, slug, id)
    if (!upload) {
      const lost: string[] = []
      for (const earlier of taken) {
        if (!(await earlier.putBack().catch(() => false))) lost.push(earlier.id)
      }
      throw new McpToolError(
        `Attachment "${id}" was just used by another call; each upload_id can be attached once. Upload that file again. Nothing was sent.` +
        (lost.length > 0 ? ` ${spentUploadsNote(lost)}` : ''),
      )
    }
    taken.push({ id, path: upload.result.path, putBack: upload.putBack })
  }
  return taken.map((upload) => upload.path)
}

const DEADLINE = Symbol('deadline')

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T | typeof DEADLINE> {
  // The losing work goes on (a container start finishes on its own); its failure is its own.
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<typeof DEADLINE>((resolve) => { timer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadline - Date.now())) })])
  } finally {
    clearTimeout(timer)
  }
}

/** A session name from the prompt's first line. */
function sessionNameFrom(prompt: string): string {
  const line = prompt.split('\n').map((part) => part.trim()).find(Boolean) ?? 'MCP session'
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

/**
 * Runs `work` with a progress notification every `PROGRESS_INTERVAL_MS` from
 * the call's start, for the whole call: a container start and the delivery
 * count as much as the wait, so a call that lasts longer than an interval
 * always reports at least once. The ticks stop before the result goes out.
 * Each send is best effort (`call.progress` never throws) and does not hold
 * the call.
 */
export async function withProgress<T>(call: McpToolCall, startedAt: number, waitSeconds: number, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const tick = () => {
    if (stopped) return
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    // The wait is the total while within it; a cold start can run past it, and then there is none to state.
    const total = elapsed <= waitSeconds ? Math.max(1, Math.round(waitSeconds)) : undefined
    background(call.progress(elapsed, total, `The agent is working (${elapsed}s)`), { name: 'mcp-server.progress' })
    timer = setTimeout(tick, PROGRESS_INTERVAL_MS)
  }
  timer = setTimeout(tick, Math.max(0, startedAt + PROGRESS_INTERVAL_MS - Date.now()))
  try {
    return await work()
  } finally {
    stopped = true
    clearTimeout(timer)
  }
}

export interface InvokeRequest {
  agent: string
  prompt: string
  sessionId?: string
  attachments?: string[]
  waitSeconds?: number
}

/**
 * invoke_agent (and ask_team_brain): a new session, a message to an existing
 * one, or the answer to the plain question it waits on; then the wait.
 */
export async function invokeAndWait(ctx: McpCallContext, call: McpToolCall, request: InvokeRequest): Promise<RunResult> {
  const startedAt = Date.now()
  return withProgress(call, startedAt, clampWaitSeconds(request.waitSeconds), () => runInvoke(ctx, call, request, startedAt))
}

async function runInvoke(ctx: McpCallContext, call: McpToolCall, request: InvokeRequest, startedAt: number): Promise<RunResult> {
  const waitDeadline = startedAt + clampWaitSeconds(request.waitSeconds) * 1000
  // However long the client asked to wait, the call returns by here.
  const callDeadline = startedAt + MAX_WAIT_SECONDS * 1000
  const target = await resolveTarget(ctx, request.agent, 'user')
  call.setAuditTarget({ agent: target.slug, ...(request.sessionId ? { sessionId: request.sessionId } : {}) })
  const actor = agentRegistry.get(target.slug)
  const attachments = request.attachments ?? []

  if (request.sessionId) {
    if (!(await actor.sessions.isKnown(request.sessionId))) throw sessionNotFound()
    const live = await actor.sessions.live(request.sessionId)
    if (live.isAwaitingInput) {
      const open = openBlocking(live.openRequests, request.sessionId)
      const question = answerableQuestion(open)
      if (!question || attachments.length > 0) {
        // Nothing is delivered: cancelling what the person is asked (a secret,
        // a sign-in) from here would take the decision away from them.
        return describe(ctx, target, request.sessionId, 'awaiting_input', undefined, {
          extraNote: attachments.length > 0 && question
            ? 'Your prompt was NOT delivered: a question is answered with text alone, without attachments.'
            : 'Your prompt was NOT delivered.',
        })
      }
      const boundary = await lastAssistant(target.slug, request.sessionId)
      const answered = await actor.inputs.answer(question.id, answersFor(question, request.prompt))
      if (answered !== 'answered') {
        throw new McpToolError(answered === 'claimed'
          ? 'Someone is answering this question right now (in Gamut, or another call). Call wait_for_session to see where the session stands.'
          : 'The question could not be answered (it may have just been answered or cancelled). Call wait_for_session to see where the session stands.')
      }
      const outcome = await waitForSettle(target.slug, request.sessionId, waitDeadline, call, { boundaryUuid: boundary?.uuid })
      return describe(ctx, target, request.sessionId, outcome, boundary?.uuid)
    }
  }

  // A cold agent can take a while to start. Starting it is safe to repeat
  // and sends nothing, so a start that outlasts the call is reported without
  // delivering the prompt: the client retries, nothing runs twice.
  if (await beforeDeadline(actor.container.start(), callDeadline - 5_000) === DEADLINE) {
    throw new McpToolError('The agent is starting up and was not ready in time. Nothing was sent. Call invoke_agent again with the same arguments in a few seconds.')
  }

  // What a client that goes away does (the call's abort signal):
  // - up to here: nothing was created or spent, and nothing is sent.
  // - from here on: the prompt is delivered whatever the client does. The
  //   service is not handed the signal (for a user caller it would only abort
  //   an agent's attachment transfer), and a session is never created without
  //   its prompt: creating one is delivering its first message. An abort then
  //   ends only this call's wait; nothing here stops a turn.
  if (call.signal.aborted) throw new McpToolError('The call was cancelled before anything was sent. Nothing was delivered.')

  const paths = await takeAttachments(ctx, target.slug, attachments)
  const prompt = appendAttachedFiles(request.prompt, paths)
  const boundary = request.sessionId ? await lastAssistant(target.slug, request.sessionId) : null
  const caller = userXAgentCaller({
    userId: ctx.userId,
    isAdmin: ctx.isAdmin,
    sessionName: sessionNameFrom(request.prompt),
    // Registered only with a session this call creates: a message to an
    // existing session changes none of its metadata (invoke.ts passes it to
    // `sessions.start` alone).
    sessionMetadata: { mcpInvocation: { userId: ctx.userId, clientName: call.clientName } },
  })
  let invoked: Awaited<ReturnType<typeof invokeAgent>>
  try {
    invoked = await invokeAgent(caller, { slug: target.slug, prompt, sessionId: request.sessionId, sync: false })
  } catch (error) {
    if (paths.length > 0) throw new McpToolError(`The prompt could not be delivered. ${spentUploadsNote(attachments)}`)
    throw error
  }
  if (!invoked.ok) {
    const refusal = failureError(invoked, 'user')
    throw paths.length > 0 ? new McpToolError(`${refusal.message} ${spentUploadsNote(attachments)}`) : refusal
  }
  const sessionId = invoked.value.sessionId
  call.setAuditTarget({ sessionId })
  if (!request.sessionId) {
    trackServerEvent('mcp_session_started', {
      client_name: call.clientName,
      credential: ctx.credential.kind,
      // A failed read must not fail a call whose session already exists.
      is_team_brain: (await getTeamBrain().catch(() => null))?.agentSlug === target.slug,
      has_attachments: paths.length > 0,
    })
  }
  const outcome = await waitForSettle(target.slug, sessionId, waitDeadline, call, { boundaryUuid: boundary?.uuid })
  return describe(ctx, target, sessionId, outcome, boundary?.uuid)
}

/**
 * Attachments are spent before delivery, so an upload is never attached twice
 * (a delivery that failed may still have gone). The client is told.
 */
function spentUploadsNote(uploadIds: string[]): string {
  return `The attached uploads (${uploadIds.join(', ')}) were used up by this call: upload the files again with prepare_file_upload and pass the new upload ids to retry.`
}

/** wait_for_session: the wait alone, on a session the person can read. */
export async function waitForSession(
  ctx: McpCallContext,
  call: McpToolCall,
  request: { agent: string; sessionId: string; waitSeconds?: number },
): Promise<RunResult> {
  const startedAt = Date.now()
  return withProgress(call, startedAt, clampWaitSeconds(request.waitSeconds), () => runWait(ctx, call, request, startedAt))
}

async function runWait(
  ctx: McpCallContext,
  call: McpToolCall,
  request: { agent: string; sessionId: string; waitSeconds?: number },
  startedAt: number,
): Promise<RunResult> {
  const deadline = startedAt + clampWaitSeconds(request.waitSeconds) * 1000
  const target = await resolveTarget(ctx, request.agent, 'viewer')
  call.setAuditTarget({ agent: target.slug, sessionId: request.sessionId })
  const actor = agentRegistry.get(target.slug)
  if (!(await actor.sessions.isKnown(request.sessionId))) throw sessionNotFound()
  // A turn running now: its reply is whatever lands after the last one seen
  // now or, when none lands, the last one there was.
  const runningNow = (await actor.sessions.live(request.sessionId)).isActive
  const boundary = runningNow ? await lastAssistant(target.slug, request.sessionId) : null
  const outcome = await waitForSettle(target.slug, request.sessionId, deadline, call)
  return describe(ctx, target, request.sessionId, outcome, boundary?.uuid, { previousReplyCounts: true })
}
