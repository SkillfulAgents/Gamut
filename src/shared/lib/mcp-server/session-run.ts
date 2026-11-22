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

/** A plain question with a payload to answer, when that is all the session waits on. */
function answerableQuestion(requests: PendingUserInputRequest[]): PendingUserInputRequest | null {
  if (requests.length === 0 || !requests.every((request) => request.kind === 'question' && isReplayableUserInputRequest(request))) return null
  return requests[0]
}

/** The question's answers map, as the app sends it: each question answered with the prompt. */
function answersFor(request: PendingUserInputRequest, answer: string): Record<string, string> {
  const questions = Array.isArray(request.payload.questions) ? request.payload.questions as Array<Record<string, unknown>> : []
  const answers: Record<string, string> = {}
  for (const question of questions) {
    if (typeof question.question === 'string') answers[question.question] = answer
  }
  return answers
}

interface LastAssistant {
  uuid: string
  text: string
  isError: boolean
}

async function lastAssistant(slug: string, sessionId: string): Promise<LastAssistant | null> {
  const entry = await agentRegistry.get(slug).messages.findLastEntry(sessionId, { kind: 'assistant' })
  if (!entry || entry.type === 'system') return null
  const compact = compactMessage(entry)
  if (!compact) return null
  return { uuid: entry.uuid, text: compact.content, isError: entry.isApiErrorMessage === true }
}

/** The last assistant message newer than `boundaryUuid`, polled briefly when the reply may still be flushing. */
async function replyAfter(slug: string, sessionId: string, boundaryUuid: string | undefined, settle: boolean): Promise<LastAssistant | null> {
  const attempts = settle ? REPLY_FLUSH_ATTEMPTS : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const last = await lastAssistant(slug, sessionId)
    if (last && last.uuid !== boundaryUuid) return last
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, REPLY_FLUSH_INTERVAL_MS))
  }
  return null
}

type WaitOutcome = 'settled' | 'awaiting_input' | 'running'

/**
 * Wait for the session to settle (idle) or to wait on the person, until
 * `deadline` or the client goes away. Looks every second, reports progress
 * every few; nothing is left behind when it returns (a look in flight ends
 * within a second on its own).
 */
async function waitForSettle(slug: string, sessionId: string, deadline: number, call: McpToolCall, startedAt: number): Promise<WaitOutcome> {
  const sessions = agentRegistry.get(slug).sessions
  let onAbort = () => {}
  const abortedNow = new Promise<'aborted'>((resolve) => { onAbort = () => resolve('aborted') })
  if (call.signal.aborted) onAbort()
  call.signal.addEventListener('abort', onAbort, { once: true })
  const totalSeconds = Math.max(1, Math.round((deadline - startedAt) / 1000))
  let nextProgressAt = Date.now() + PROGRESS_INTERVAL_MS
  try {
    for (;;) {
      const live = await sessions.live(sessionId)
      if (live.isAwaitingInput) return 'awaiting_input'
      if (!live.isActive) return 'settled'
      const remaining = deadline - Date.now()
      if (call.signal.aborted || remaining <= 0) return 'running'
      if (Date.now() >= nextProgressAt) {
        nextProgressAt += PROGRESS_INTERVAL_MS
        const elapsed = Math.round((Date.now() - startedAt) / 1000)
        await call.progress(elapsed, totalSeconds, `The agent is working (${elapsed}s)`)
      }
      // One slice: the session going idle, the slice's end, or the client
      // leaving. A slice that loses to an abort ends by itself within a second.
      await Promise.race([
        sessions.waitForIdle(sessionId, { timeoutMs: Math.min(remaining, POLL_SLICE_MS) }).catch(() => 'timeout' as const),
        abortedNow,
      ])
    }
  } finally {
    call.signal.removeEventListener('abort', onAbort)
  }
}

/** Where the session stands now, in the result shape. */
async function describe(
  ctx: McpCallContext,
  target: Target,
  sessionId: string,
  outcome: WaitOutcome,
  boundaryUuid: string | undefined,
  extraNote?: string,
): Promise<RunResult> {
  const actor = agentRegistry.get(target.slug)
  const { deliveredFiles } = await actor.messages.transcriptView(sessionId, { limit: 1 })
  const delivered_files = deliveredFiles.map((file) => ({ delivery_id: file.deliveryId, filename: file.filename, size_bytes: file.sizeBytes }))
  const base = { agent: target.display, session_id: sessionId, delivered_files }

  if (outcome === 'awaiting_input') {
    const live = await actor.sessions.live(sessionId)
    const open = openBlocking(live.openRequests, sessionId)
    const question = answerableQuestion(open)
    const request = question ?? open.find((candidate) => candidate.kind !== 'question') ?? open[0]
    const last = await replyAfter(target.slug, sessionId, boundaryUuid, false)
    const pending: PendingRequest = {
      kind: request?.kind ?? 'unknown',
      text: request ? requestText(request) : 'The agent is waiting on the person in Gamut.',
      open_in_gamut_url: await sessionLink(ctx, target.slug, sessionId),
    }
    const note = question
      ? 'The agent asked a question. Answer it by calling invoke_agent with this agent and session_id, and the answer as prompt. If you do not know the answer, ask the person you are working for; they can also answer in Gamut at open_in_gamut_url.'
      : 'The agent is waiting on the person, in Gamut: this cannot be done through this server. Give the person open_in_gamut_url; once they have dealt with it, call wait_for_session with this session_id.'
    return {
      ...base,
      status: 'awaiting_input',
      last_message: last ? truncateText(last.text, LAST_MESSAGE_MAX_CHARS).text : null,
      pending_request: pending,
      note: extraNote ? `${extraNote} ${note}` : note,
    }
  }

  if (outcome === 'running') {
    const last = await replyAfter(target.slug, sessionId, boundaryUuid, false)
    return {
      ...base,
      status: 'running',
      last_message: last ? truncateText(last.text, LAST_MESSAGE_MAX_CHARS).text : null,
      pending_request: null,
      note: 'The agent is still working. Call wait_for_session with this agent and session_id to keep waiting. Do NOT call invoke_agent again for the same request: that would start a second run.',
    }
  }

  const reply = await replyAfter(target.slug, sessionId, boundaryUuid, true)
  const failed = reply?.isError === true
  return {
    ...base,
    status: failed ? 'failed' : 'completed',
    last_message: reply ? truncateText(reply.text, LAST_MESSAGE_MAX_CHARS).text : null,
    pending_request: null,
    ...(failed
      ? { note: 'The agent\'s turn ended with an error (last_message). You can retry by calling invoke_agent with this session_id.' }
      : reply ? {} : { note: 'The session is idle and wrote no new reply.' }),
  }
}

/**
 * The uploads named by `attachments`, each taken for one use, as workspace
 * paths for the prompt. All or nothing: every id is checked before any is
 * spent, so a bad id leaves the others usable.
 */
async function takeAttachments(ctx: McpCallContext, slug: string, uploadIds: string[]): Promise<string[]> {
  if (uploadIds.length === 0) return []
  if (uploadIds.length > MAX_ATTACHMENTS) throw new McpToolError(`At most ${MAX_ATTACHMENTS} attachments per call.`)
  for (const id of uploadIds) {
    if (!(await resolveSignedUpload(ctx.userId, slug, id))) {
      throw new McpToolError(`Attachment "${id}" is not a finished upload for this agent: call prepare_file_upload with this agent, PUT the file to its upload_url, then pass its upload_id here. Each upload_id can be attached once.`)
    }
  }
  const paths: string[] = []
  for (const id of uploadIds) {
    const taken = await takeSignedUpload(ctx.userId, slug, id)
    if (!taken) throw new McpToolError(`Attachment "${id}" was just used by another call; each upload_id can be attached once. Upload the file again.`)
    paths.push(taken.path)
  }
  return paths
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
        return describe(ctx, target, request.sessionId, 'awaiting_input', undefined,
          attachments.length > 0 && question
            ? 'Your prompt was NOT delivered: a question is answered with text alone, without attachments.'
            : 'Your prompt was NOT delivered.')
      }
      const boundary = await lastAssistant(target.slug, request.sessionId)
      const answered = await actor.inputs.answer(question.id, answersFor(question, request.prompt))
      if (answered !== 'answered') {
        throw new McpToolError(answered === 'claimed'
          ? 'Someone is answering this question right now (in Gamut, or another call). Call wait_for_session to see where the session stands.'
          : 'The question could not be answered (it may have just been answered or cancelled). Call wait_for_session to see where the session stands.')
      }
      const outcome = await waitForSettle(target.slug, request.sessionId, waitDeadline, call, startedAt)
      return describe(ctx, target, request.sessionId, outcome, boundary?.uuid)
    }
  }

  // A cold agent can take a while to start. Starting it is safe to repeat
  // and sends nothing, so a start that outlasts the call is reported without
  // delivering the prompt: the client retries, nothing runs twice.
  if (await beforeDeadline(actor.container.start(), callDeadline - 5_000) === DEADLINE) {
    throw new McpToolError('The agent is starting up and was not ready in time. Nothing was sent. Call invoke_agent again with the same arguments in a few seconds.')
  }

  const paths = await takeAttachments(ctx, target.slug, attachments)
  const prompt = appendAttachedFiles(request.prompt, paths)
  const boundary = request.sessionId ? await lastAssistant(target.slug, request.sessionId) : null
  const caller = userXAgentCaller({
    userId: ctx.userId,
    isAdmin: ctx.isAdmin,
    sessionName: sessionNameFrom(request.prompt),
    sessionMetadata: { mcpInvocation: { userId: ctx.userId, clientName: call.clientName } },
  })
  const invoked = await invokeAgent(caller, {
    slug: target.slug,
    prompt,
    sessionId: request.sessionId,
    sync: false,
    signal: call.signal,
  })
  if (!invoked.ok) throw failureError(invoked, 'user')
  const sessionId = invoked.value.sessionId
  call.setAuditTarget({ sessionId })
  const outcome = await waitForSettle(target.slug, sessionId, waitDeadline, call, startedAt)
  return describe(ctx, target, sessionId, outcome, boundary?.uuid)
}

/** wait_for_session: the wait alone, on a session the person can read. */
export async function waitForSession(
  ctx: McpCallContext,
  call: McpToolCall,
  request: { agent: string; sessionId: string; waitSeconds?: number },
): Promise<RunResult> {
  const startedAt = Date.now()
  const deadline = startedAt + clampWaitSeconds(request.waitSeconds) * 1000
  const target = await resolveTarget(ctx, request.agent, 'viewer')
  call.setAuditTarget({ agent: target.slug, sessionId: request.sessionId })
  const actor = agentRegistry.get(target.slug)
  if (!(await actor.sessions.isKnown(request.sessionId))) throw sessionNotFound()
  // A turn running now: its reply is whatever lands after the last one seen now.
  const runningNow = (await actor.sessions.live(request.sessionId)).isActive
  const boundary = runningNow ? await lastAssistant(target.slug, request.sessionId) : null
  const outcome = await waitForSettle(target.slug, request.sessionId, deadline, call, startedAt)
  if (outcome === 'settled' && boundary) {
    const result = await describe(ctx, target, request.sessionId, outcome, boundary.uuid)
    // The turn ended without a newer reply: what was there is the answer.
    if (result.last_message === null) {
      const rest: RunResult = { ...result }
      delete rest.note
      return { ...rest, status: boundary.isError ? 'failed' : 'completed', last_message: truncateText(boundary.text, LAST_MESSAGE_MAX_CHARS).text }
    }
    return result
  }
  return describe(ctx, target, request.sessionId, outcome, undefined)
}
