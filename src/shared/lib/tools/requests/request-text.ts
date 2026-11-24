/**
 * An agent's open request as text, for the surfaces where a person (or an
 * external agent) reads it outside the app: the MCP server, the chat
 * integrations, the email integration.
 *
 * Building blocks, not one rule. Which open question a typed reply may answer
 * differs by surface on purpose, and each keeps its own rule:
 * - chat (resolve-awaiting-input.ts): the first open question request that is
 *   not a recovered stub, whatever else is open; the connector then answers
 *   it only when its posted card asked exactly one question (Telegram), or
 *   not at all (every other connector);
 * - MCP (mcp-server/session-run.ts): only when the session waits on exactly
 *   one request and it is one plain question (`isSinglePlainQuestion`).
 */
import { z } from 'zod'

const questionsSchema = z.object({ questions: z.array(z.object({
  question: z.string().min(1), header: z.string().optional(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).default([]),
  multiSelect: z.boolean().default(false),
})).min(1) })
export type RequestQuestion = z.infer<typeof questionsSchema>['questions'][number]

/** What these helpers read of a request: its kind and its payload as stored. */
export interface RequestLike {
  kind: string
  payload: unknown
}

/** A stub transcript recovery synthesized: it carries no payload to show or answer. */
export function isRecoveredRequest(request: RequestLike): boolean {
  return !!request.payload && typeof request.payload === 'object' && (request.payload as { recovered?: unknown }).recovered === true
}

/** The questions of an AskUserQuestion request, or null for any other request (or a recovered stub, or a payload that does not parse). */
export function requestQuestions(request: RequestLike): RequestQuestion[] | null {
  if (request.kind !== 'question') return null
  const parsed = questionsSchema.safeParse(request.payload)
  return parsed.success ? parsed.data.questions : null
}

/** An open question request a person could see as a card: a question that is not a recovered stub. */
export function isOpenQuestion(request: RequestLike): boolean {
  return request.kind === 'question' && !isRecoveredRequest(request)
}

/** One plain question a typed reply can answer: a question request whose payload asks exactly one thing. */
export function isSinglePlainQuestion(request: RequestLike): boolean {
  return requestQuestions(request)?.length === 1
}

/** One question as a line: its text, and its options when it has any. */
export function questionLine(question: RequestQuestion): string {
  const labels = question.options.map((option) => option.label)
  return labels.length > 0 ? `${question.question} (options: ${labels.join(', ')})` : question.question
}

/** What the person is asked, in one line or a few, for any kind of request. */
export function requestText(request: RequestLike): string {
  const payload = (request.payload && typeof request.payload === 'object' ? request.payload : {}) as Record<string, unknown>
  const str = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : undefined)
  const withReason = (text: string) => (str('reason') ? `${text}: ${str('reason')}` : text)
  switch (request.kind) {
    case 'question': return requestQuestions(request)?.map(questionLine).join('\n') || 'The agent asked a question.'
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
