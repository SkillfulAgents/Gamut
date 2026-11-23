/**
 * The run tools against a test database (people, agents, roles: auth mode)
 * and a fake agent actor whose sessions settle, keep running or wait on the
 * person as each test arranges. The x-agent service's delivery is replaced by
 * one that starts or messages a fake session, so what is under test is the
 * MCP layer: who may run what, the wait, the result shape, the question path,
 * attachments, downloads, list_sessions, the audit row and the rate limit.
 * The real delivery runs in the E2E suite (e2e/mcp/run-tools.spec.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { agentAcl, agents, auditLog, user } from '@shared/lib/db/schema'
import { runtimeCapabilities } from '@shared/lib/facts/capabilities'
import { declareServerCapabilities } from '@shared/lib/facts/server-facts'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
const analytics = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({
  trackServerEvent: (...args: unknown[]) => analytics.track(...args),
}))
vi.mock('@shared/lib/auth/config', async (original) => ({
  ...(await original<typeof import('@shared/lib/auth/config')>()),
  getAppBaseUrl: async () => 'https://gamut.test',
}))

const fake = vi.hoisted(() => {
  interface FakeEntry {
    kind: 'user' | 'assistant'
    uuid: string
    text: string
    isApiErrorMessage?: boolean
    /** An assistant entry with a tool call and no text (an AskUserQuestion). */
    toolOnly?: string
  }
  interface FakeSession {
    id: string
    agent: string
    name: string
    metadata: Record<string, unknown>
    active: boolean
    awaiting: boolean
    openRequests: Array<{ id: string; kind: string; blocking: boolean; autoApproved: boolean; scope: { sessionId?: string }; payload: Record<string, unknown> }>
    entries: FakeEntry[]
    delivered: Array<{ deliveryId: string; filename: string; sizeBytes: number; filePath: string }>
    prompts: string[]
  }
  const state = {
    sessions: new Map<string, FakeSession>(),
    files: new Map<string, Uint8Array>(),
    answers: [] as Array<{ id: string; value: unknown }>,
    waitCalls: 0,
    next: 0,
  }
  function blank(id: string, agent: string, name: string, metadata: Record<string, unknown>): FakeSession {
    return { id, agent, name, metadata, active: false, awaiting: false, openRequests: [], entries: [], delivered: [], prompts: [] }
  }
  function say(session: FakeSession, text: string, extra: Partial<FakeEntry> = {}) {
    session.entries.push({ kind: 'assistant', uuid: `a-${session.entries.length}-${session.id}`, text, ...extra })
  }
  const question = (text: string) => ({ question: text, options: [{ label: 'Red' }, { label: 'Blue' }] })
  /** What a delivered prompt makes the fake session do. */
  function play(session: FakeSession, prompt: string) {
    session.prompts.push(prompt)
    session.entries.push({ kind: 'user', uuid: `u-${session.entries.length}-${session.id}`, text: prompt })
    // Delivered but not begun: no active mark, the turn runs later (or never).
    if (prompt.includes('[late]')) {
      setTimeout(() => say(session, 'Late but here'), 4_000)
      return
    }
    if (prompt.includes('[never]')) return
    session.active = true
    if (prompt.includes('[slow]')) {
      say(session, 'Working on it, step 1 done.')
      say(session, '', { toolOnly: 'Bash' })
      return
    }
    const ask = (requests: FakeSession['openRequests']) => {
      say(session, 'Let me ask you.')
      say(session, '', { toolOnly: 'AskUserQuestion' })
      session.awaiting = true
      session.openRequests = requests
    }
    const request = (id: string, kind: string, payload: Record<string, unknown>) => ({ id, kind, blocking: true, autoApproved: false, scope: { sessionId: session.id }, payload })
    if (prompt.includes('[questions]')) return ask([request(`q-${session.id}`, 'question', { questions: [question('Which colour?'), question('Which shade?')] })])
    if (prompt.includes('[question+secret]')) {
      return ask([
        request(`q-${session.id}`, 'question', { questions: [question('Which colour?')] }),
        request(`s-${session.id}`, 'secret', { secretName: 'API_KEY' }),
      ])
    }
    if (prompt.includes('[question]')) return ask([request(`q-${session.id}`, 'question', { questions: [question('Which colour?')] })])
    if (prompt.includes('[secret]')) {
      session.awaiting = true
      session.openRequests = [request(`s-${session.id}`, 'secret', { secretName: 'API_KEY', reason: 'to call the API' })]
      return
    }
    if (prompt.includes('[deliver]')) {
      session.delivered.push({ deliveryId: 'd1', filename: 'report.md', sizeBytes: 5, filePath: '/workspace/output/report.md' })
    }
    setTimeout(() => {
      say(session, prompt.includes('[fail]') ? 'API Error: overloaded' : `Reply to: ${prompt.split('\n')[0]}`, { isApiErrorMessage: prompt.includes('[fail]') })
      session.active = false
    }, 30)
  }
  return { state, play, say, blank }
})

vi.mock('@shared/lib/agent-actor/registry', () => ({
  agentRegistry: {
    get: (slug: string) => {
      const of = () => [...fake.state.sessions.values()].filter((session) => session.agent === slug)
      const find = (id: string) => of().find((session) => session.id === id)
      return {
        live: async () => ({ container: { status: 'running', port: null, healthWarnings: [], stale: false, idleSince: null }, activeSessionIds: of().filter((s) => s.active).map((s) => s.id) }),
        container: { start: async () => {} },
        sessions: {
          list: async () => of().map((session) => ({ id: session.id, agentSlug: slug, name: session.name, createdAt: new Date(1), lastActivityAt: new Date(2) })),
          readMetadata: async () => Object.fromEntries(of().map((session) => [session.id, session.metadata])),
          metadata: async (id: string) => find(id)?.metadata ?? null,
          isKnown: async (id: string) => !!find(id),
          live: async (id: string) => {
            const session = find(id)
            return { isActive: !!session?.active, isAwaitingInput: !!session?.awaiting, openRequests: session?.openRequests ?? [] }
          },
          waitForIdle: async (id: string, opts: { timeoutMs?: number } = {}) => {
            fake.state.waitCalls++
            await new Promise((resolve) => setTimeout(resolve, Math.min(opts.timeoutMs ?? 50, 50)))
            return find(id)?.active ? 'timeout' : 'idle'
          },
        },
        messages: {
          findLastEntry: async (id: string) => {
            const last = find(id)?.entries.filter((entry) => entry.kind === 'assistant').at(-1)
            if (!last) return null
            const content = last.toolOnly ? [{ type: 'tool_use', id: `t-${last.uuid}`, name: last.toolOnly, input: {} }] : [{ type: 'text', text: last.text }]
            return { type: 'assistant', uuid: last.uuid, isApiErrorMessage: last.isApiErrorMessage, message: { content } }
          },
          // The spoken view: prompts, the agent's text, and a stub for tool-only turns.
          transcriptView: async (id: string, opts: { limit?: number } = {}) => {
            const view = (find(id)?.entries ?? []).map((entry) => (entry.kind === 'user'
              ? { role: 'user', content: entry.text }
              : entry.toolOnly ? { role: 'system', content: 'tool calls + thinking' } : { role: 'assistant', content: entry.text }))
            return { messages: opts.limit ? view.slice(-opts.limit) : view, total: view.length, deliveredFiles: find(id)?.delivered ?? [] }
          },
          findDeliveredFile: async (id: string, deliveryId: string) => find(id)?.delivered.find((file) => file.deliveryId === deliveryId),
        },
        inputs: {
          answer: async (id: string, value: unknown) => {
            const session = of().find((candidate) => candidate.openRequests.some((request) => request.id === id))
            if (!session) return 'not-open'
            fake.state.answers.push({ id, value })
            session.openRequests = []
            session.awaiting = false
            setTimeout(() => {
              fake.say(session, `Thanks for ${JSON.stringify(value)}`)
              session.active = false
            }, 30)
            return 'answered'
          },
        },
        files: {
          write: async (path: string, body: ReadableStream<Uint8Array> | Uint8Array) => {
            const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer())
            fake.state.files.set(`${slug}:${path}`, bytes)
            return { size: bytes.byteLength }
          },
          delete: async (path: string) => { fake.state.files.delete(`${slug}:${path}`) },
          readSized: async (path: string) => {
            const { WorkspaceFileError } = await import('@shared/lib/agent-actor/workspace-path')
            const bytes = fake.state.files.get(`${slug}:${path.replace(/^\/workspace\//, '')}`)
            if (!bytes) throw new WorkspaceFileError('not-found')
            return { size: bytes.byteLength, stream: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() }
          },
        },
      }
    },
  },
}))

/**
 * The service's delivery, faked: it starts or messages a session. A prompt
 * with `[refuse]` is refused (a failure before anything is sent), and one with
 * `[slow-deliver]` takes 300ms to be delivered.
 */
vi.mock('@shared/lib/services/x-agent/invoke', () => ({
  invokeAgent: async (caller: { kind: string; sessionName: string; sessionMetadata: Record<string, unknown> }, input: { slug: string; prompt: string; sessionId?: string; signal?: AbortSignal }) => {
    if (input.signal) throw new Error('The MCP layer must not hand the call signal to the service')
    if (input.prompt.includes('[refuse]')) return { ok: false, status: 500, error: 'Failed to invoke agent (ensure_running): boom' }
    if (input.prompt.includes('[slow-deliver]')) await new Promise((resolve) => setTimeout(resolve, 300))
    // A cold agent: two seconds before the prompt is delivered.
    if (input.prompt.includes('[cold]')) await new Promise((resolve) => setTimeout(resolve, 2_000))
    let session = input.sessionId ? fake.state.sessions.get(input.sessionId) : undefined
    if (!session) {
      const id = `session-${++fake.state.next}`
      session = fake.blank(id, input.slug, caller.sessionName, { ...caller.sessionMetadata, createdAt: new Date().toISOString() })
      fake.state.sessions.set(id, session)
    }
    fake.play(session, input.prompt)
    return { ok: true, value: { sessionId: session.id, status: 'running' } }
  },
}))

import { eq } from 'drizzle-orm'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { mutateSettings } from '@shared/lib/config/settings'
import { sessionOrigin, isHiddenAutomatedSession } from '@shared/lib/services/session-visibility'
import { sessionMetadataSchema } from '@shared/lib/services/session-metadata-schema'
import type { SessionMetadata } from '@shared/lib/types/agent'
import { authorizeSignedFileRequest, storeSignedUpload } from '@shared/lib/signed-file-urls/signed-file-urls'
import type { McpCallContext } from '../context'
import { registerTools } from '../registry'
import { clampWaitSeconds, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS } from '../session-run'
import { MCP_TOOL_CALLS_PER_MINUTE } from '../tool-call-guard'
import { detachedCall, type McpToolCall, type McpToolDefinition } from '../tool-definition'
import { jsonResult, runTool } from '../tool-result'
import { askTeamBrainTool, invokeAgentTool, waitForSessionTool } from './run-tools'
import { getFileDownload, prepareFileUpload } from './file-tools'
import { listSessions } from './session-tools'
import { getGuide } from './guide-tools'

function person(userId: string, isAdmin = false): McpCallContext {
  return { userId, isAdmin, publicBaseUrl: 'https://gamut.test', credential: { kind: 'installation-token' }, scopes: ['read', 'run'] }
}

async function call(tool: McpToolDefinition<any, any>, args: Record<string, unknown>, ctx: McpCallContext, extra: Partial<McpToolCall> = {}) {
  const result = await runTool(tool.name, async () => jsonResult(await tool.handler(tool.input.parse(args), ctx, detachedCall(extra))))
  return { error: result.isError ? (result.content[0] as { text: string }).text : null, value: result.structuredContent as any }
}

/** The tools as the server registers them, callable with a fake request context. */
function registered(ctx: McpCallContext, era?: 'legacy' | 'modern') {
  const handlers = new Map<string, (args: unknown, context?: ServerContext) => Promise<any>>()
  registerTools({ registerTool: (name: string, _config: unknown, handler: never) => { handlers.set(name, handler) } } as unknown as McpServer, ctx, undefined, { era })
  return (name: string, args: Record<string, unknown>, clientName: string | null = null) => handlers.get(name)!(args, {
    mcpReq: {
      signal: new AbortController().signal,
      envelope: clientName ? { 'io.modelcontextprotocol/clientInfo': { name: clientName, version: '1' } } : undefined,
      notify: async () => {},
    },
  } as unknown as ServerContext)
}

async function auditRows() {
  await backgroundSettled()
  return (await handle.db.select().from(auditLog).where(eq(auditLog.object, 'mcp_tool'))).map((row) => ({ ...row, details: JSON.parse(row.details ?? '{}') }))
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  declareServerCapabilities(runtimeCapabilities({ os: 'darwin', distribution: 'direct' }))
  fake.state.sessions.clear()
  fake.state.files.clear()
  fake.state.answers.length = 0
  analytics.track.mockClear()
  handle = await createTestDatabase()
  await handle.db.insert(user).values([
    { id: 'alice', name: 'Alice', email: 'alice@example.com' },
    { id: 'bob', name: 'Bob', email: 'bob@example.com' },
    { id: 'victor', name: 'Victor', email: 'victor@example.com' },
    { id: 'nobody', name: 'Nobody', email: 'nobody@example.com' },
  ]).run()
  await handle.db.insert(agents).values([
    { slug: 'alpha', name: 'Alpha', createdAt: new Date() },
    { slug: 'beta', name: 'Beta', createdAt: new Date() },
  ]).run()
  await handle.db.insert(agentAcl).values([
    { id: '1', userId: 'alice', agentSlug: 'alpha', role: 'user', createdAt: new Date() },
    { id: '2', userId: 'bob', agentSlug: 'alpha', role: 'owner', createdAt: new Date() },
    { id: '3', userId: 'victor', agentSlug: 'alpha', role: 'viewer', createdAt: new Date() },
    { id: '4', userId: 'alice', agentSlug: 'beta', role: 'user', createdAt: new Date() },
  ]).run()
})

afterEach(async () => {
  declareServerCapabilities(null)
  await backgroundSettled()
  await handle.close()
  vi.unstubAllEnvs()
})

describe('the wait', () => {
  it('defaults to 45 seconds, never more than 50, and takes 0 to mean do not wait', () => {
    expect(DEFAULT_WAIT_SECONDS).toBe(45)
    expect(MAX_WAIT_SECONDS).toBe(50)
    expect(clampWaitSeconds(undefined)).toBe(45)
    expect(clampWaitSeconds(10)).toBe(10)
    expect(clampWaitSeconds(500)).toBe(50)
    expect(clampWaitSeconds(-3)).toBe(0)
    expect(clampWaitSeconds(Number.NaN)).toBe(45)
    expect(clampWaitSeconds(Number.POSITIVE_INFINITY)).toBe(45)
  })

  it('refuses a wait that is not a number', () => {
    expect(invokeAgentTool.input.safeParse({ agent: 'alpha', prompt: 'hi', wait_seconds: 'soon' }).success).toBe(false)
  })

  it('a turn that ends in time answers completed with the reply', async () => {
    const { value, error } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Summarize the week' }, person('alice'))
    expect(error).toBeNull()
    expect(value).toMatchObject({ agent: 'alpha', status: 'completed', last_message: 'Reply to: Summarize the week', pending_request: null, delivered_files: [] })
  })

  it('a turn still running when the wait ends answers running, with the note to wait and not to invoke again', async () => {
    const started = Date.now()
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Long job [slow]', wait_seconds: 1 }, person('alice'))
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(value.status).toBe('running')
    expect(value.note).toMatch(/Call wait_for_session/)
    expect(value.note).toMatch(/Do NOT call invoke_agent again/)
    // wait_for_session picks it up once it ends.
    const session = fake.state.sessions.get(value.session_id)!
    setTimeout(() => {
      fake.say(session, 'Done at last')
      session.active = false
    }, 200)
    const waited = await call(waitForSessionTool, { agent: 'alpha', session_id: value.session_id, wait_seconds: 5 }, person('alice'))
    expect(waited.value).toMatchObject({ status: 'completed', last_message: 'Done at last' })
  })

  it('a turn that ends with an API error answers failed', async () => {
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Break [fail]' }, person('alice'))
    expect(value).toMatchObject({ status: 'failed', last_message: 'API Error: overloaded' })
  })

  it('a client that goes away ends only its wait: the call returns at once, the session runs on, and nothing keeps polling', async () => {
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Long job [slow]', wait_seconds: 0 }, person('alice'))
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const started = Date.now()
    const waited = await call(waitForSessionTool, { agent: 'alpha', session_id: value.session_id, wait_seconds: 30 }, person('alice'), { signal: controller.signal })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(waited.value.status).toBe('running')
    expect(fake.state.sessions.get(value.session_id)!.active).toBe(true)
    const calls = fake.state.waitCalls
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fake.state.waitCalls).toBe(calls)
  })
})

describe('who may run what', () => {
  it('a viewer cannot invoke; someone with no role is told the agent is not found', async () => {
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'hi' }, person('victor'))).error).toMatch(/needs the user role or higher/)
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'hi' }, person('nobody'))).error).toMatch(/Agent not found/)
    expect((await call(prepareFileUpload, { agent: 'alpha', filename: 'a.txt' }, person('victor'))).error).toMatch(/needs the user role or higher/)
    expect(fake.state.sessions.size).toBe(0)
  })

  it('a viewer can wait on and download from a session; someone with no role cannot', async () => {
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'hi' }, person('alice'))
    expect((await call(waitForSessionTool, { agent: 'alpha', session_id: value.session_id }, person('victor'))).value.status).toBe('completed')
    expect((await call(waitForSessionTool, { agent: 'alpha', session_id: value.session_id }, person('nobody'))).error).toMatch(/Agent not found/)
    // A session of another agent is not found under this one.
    expect((await call(waitForSessionTool, { agent: 'beta', session_id: value.session_id }, person('alice'))).error).toMatch(/Session not found/)
  })

  it('a credential without the run scope cannot invoke, and the refusal is audited', async () => {
    const readOnly = { ...person('alice'), scopes: ['read'] as const }
    const result = await registered(readOnly)('invoke_agent', { agent: 'alpha', prompt: 'hi' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/gamut:run/)
    expect(fake.state.sessions.size).toBe(0)
    expect((await auditRows())[0].details).toMatchObject({ tool: 'invoke_agent', outcome: 'error' })
  })
})

describe('sessions waiting on a person', () => {
  it('a plain question: awaiting_input with the question; invoke with the same session_id answers it and the turn goes on', async () => {
    const asked = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Paint it [question]' }, person('alice'))).value
    expect(asked.status).toBe('awaiting_input')
    expect(asked.pending_request).toEqual({ kind: 'question', text: 'Which colour? (options: Red, Blue)', open_in_gamut_url: `https://gamut.test/agents/alpha/sessions/${asked.session_id}` })
    expect(asked.note).toMatch(/invoke_agent with this agent and session_id/)

    const answered = (await call(invokeAgentTool, { agent: 'alpha', session_id: asked.session_id, prompt: 'Blue' }, person('alice'))).value
    expect(fake.state.answers).toEqual([{ id: `q-${asked.session_id}`, value: { 'Which colour?': 'Blue' } }])
    expect(answered).toMatchObject({ session_id: asked.session_id, status: 'completed', last_message: 'Thanks for {"Which colour?":"Blue"}' })
    // Answered, not delivered as a new message.
    expect(fake.state.sessions.get(asked.session_id)!.prompts).toEqual(['Paint it [question]'])
  })

  it('any other request: pending_request with the link to open the session in Gamut, and a prompt is not delivered', async () => {
    const asked = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Call it [secret]' }, person('alice'))).value
    expect(asked).toMatchObject({ status: 'awaiting_input', pending_request: { kind: 'secret', text: 'The agent needs the secret API_KEY: to call the API', open_in_gamut_url: `https://gamut.test/agents/alpha/sessions/${asked.session_id}` } })
    expect(asked.note).toMatch(/open_in_gamut_url/)
    const again = (await call(invokeAgentTool, { agent: 'alpha', session_id: asked.session_id, prompt: 'sk-123' }, person('alice'))).value
    expect(again.status).toBe('awaiting_input')
    expect(again.note).toMatch(/NOT delivered/)
    expect(fake.state.sessions.get(asked.session_id)!.prompts).toEqual(['Call it [secret]'])
    expect(fake.state.answers).toEqual([])
  })
})

describe('the mcp origin', () => {
  it('a session started here carries who and which client, is the mcp origin, and is hidden until promoted', async () => {
    const result = await registered(person('alice'))('invoke_agent', { agent: 'alpha', prompt: 'hi' }, 'Claude Code')
    const meta = fake.state.sessions.get(result.structuredContent.session_id)!.metadata
    expect(meta.mcpInvocation).toEqual({ userId: 'alice', clientName: 'Claude Code' })
    const parsed = sessionMetadataSchema.parse(meta) as SessionMetadata
    expect(sessionOrigin(parsed)).toBe('mcp')
    expect(isHiddenAutomatedSession(parsed)).toBe(true)
    expect(isHiddenAutomatedSession({ ...parsed, promotedToInteractive: true })).toBe(false)
    expect(sessionOrigin({ ...parsed, promotedToInteractive: true })).toBe('mcp')
    // A 2025-era call carries no client name.
    const legacy = await registered(person('alice'))('invoke_agent', { agent: 'alpha', prompt: 'hi' })
    expect(fake.state.sessions.get(legacy.structuredContent.session_id)!.metadata.mcpInvocation).toEqual({ userId: 'alice', clientName: null })
  })

  it('list_sessions lists what the app lists plus the person\'s own MCP sessions, not someone else\'s hidden ones', async () => {
    const mine = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'mine' }, person('alice'))).value.session_id
    const bobs = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'bobs' }, person('bob'))).value.session_id
    fake.state.sessions.set('regular', fake.blank('regular', 'alpha', 'Regular', {}))
    fake.state.sessions.set('cron', fake.blank('cron', 'alpha', 'Cron', { isScheduledExecution: true }))
    fake.state.sessions.set('promoted', fake.blank('promoted', 'alpha', 'Promoted', { mcpInvocation: { userId: 'bob', clientName: null }, promotedToInteractive: true }))
    const ids = (userId: string) => call(listSessions, { agent: 'alpha' }, person(userId)).then((result) => result.value.sessions.map((s: { session_id: string }) => s.session_id).sort())
    expect(await ids('alice')).toEqual([mine, 'promoted', 'regular'].sort())
    expect(await ids('bob')).toEqual([bobs, 'promoted', 'regular'].sort())
  })
})

describe('attachments', () => {
  async function upload(userId: string, agent: string, body: string): Promise<string> {
    const prepared = (await call(prepareFileUpload, { agent, filename: 'notes.txt' }, person(userId))).value
    expect(prepared.upload_url.startsWith('https://gamut.test/api/signed-files/')).toBe(true)
    expect(prepared.instructions).toContain(prepared.upload_url)
    const grant = await authorizeSignedFileRequest(prepared.upload_url.split('/').pop()!, 'upload')
    await storeSignedUpload(grant, new Response(body).body, body.length)
    return prepared.upload_id
  }

  it('an upload id reaches the prompt as its workspace path, once', async () => {
    const id = await upload('alice', 'alpha', 'hello')
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Read this', attachments: [id] }, person('alice'))
    expect(value.status).toBe('completed')
    const prompt = fake.state.sessions.get(value.session_id)!.prompts[0]
    expect(prompt).toMatch(/^Read this\n\n/)
    expect(prompt).toMatch(/- \/workspace\/uploads\/notes-[A-Za-z0-9_-]{24}-\d+\.txt/)
    // Used: a second attach is refused before anything is sent.
    const before = fake.state.sessions.size
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'Again', attachments: [id] }, person('alice'))).error).toMatch(/not a finished upload/)
    expect(fake.state.sessions.size).toBe(before)
  })

  it('is bound to the person and the agent: another person\'s id, or one for another agent, is refused and stays usable', async () => {
    const bobs = await upload('bob', 'alpha', 'from bob')
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'x', attachments: [bobs] }, person('alice'))).error).toMatch(/not a finished upload/)
    const forBeta = await upload('alice', 'beta', 'for beta')
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'x', attachments: [forBeta] }, person('alice'))).error).toMatch(/not a finished upload/)
    expect(fake.state.sessions.size).toBe(0)
    // Still good where it belongs.
    expect((await call(invokeAgentTool, { agent: 'beta', prompt: 'x', attachments: [forBeta] }, person('alice'))).value.status).toBe('completed')
  })

  it('all or nothing: one bad id spends none of the others', async () => {
    const good = await upload('alice', 'alpha', 'good')
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'x', attachments: [good, 'A'.repeat(24)] }, person('alice'))).error).toMatch(/not a finished upload/)
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'x', attachments: [good] }, person('alice'))).value.status).toBe('completed')
  })
})

describe('get_file_download', () => {
  it('a delivered file: a signed URL, and its text inline', async () => {
    fake.state.files.set('alpha:output/report.md', new TextEncoder().encode('# Hi\n'))
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Make it [deliver]' }, person('alice'))
    expect(value.delivered_files).toEqual([{ delivery_id: 'd1', filename: 'report.md', size_bytes: 5 }])
    const download = (await call(getFileDownload, { agent: 'alpha', session_id: value.session_id, delivery_id: 'd1' }, person('victor'))).value
    expect(download).toMatchObject({ filename: 'report.md', size_bytes: 5, text: '# Hi\n' })
    expect(download.download_url.startsWith('https://gamut.test/api/signed-files/')).toBe(true)
    expect((await call(getFileDownload, { agent: 'alpha', session_id: value.session_id, delivery_id: 'nope' }, person('alice'))).error).toMatch(/not found/)
  })

  it('a workspace path, and a path that leaves the workspace refused', async () => {
    fake.state.files.set('alpha:notes/a.txt', new TextEncoder().encode('note'))
    expect((await call(getFileDownload, { agent: 'alpha', path: '/workspace/notes/a.txt' }, person('alice'))).value).toMatchObject({ filename: 'a.txt', size_bytes: 4, text: 'note' })
    for (const path of ['../outside.txt', 'notes/../../etc/passwd', '/etc/passwd']) {
      expect((await call(getFileDownload, { agent: 'alpha', path }, person('alice'))).error, path).toMatch(/Invalid path|No file/)
    }
    expect((await call(getFileDownload, { agent: 'alpha', path: 'x', session_id: 's', delivery_id: 'd' }, person('alice'))).error).toMatch(/not both/)
  })

  it('a binary file is a URL only', async () => {
    fake.state.files.set('alpha:img.png', new Uint8Array([0x89, 0x50, 0x00, 0x01]))
    expect((await call(getFileDownload, { agent: 'alpha', path: 'img.png' }, person('alice'))).value).toMatchObject({ text: null, size_bytes: 4 })
  })
})

describe('ask_team_brain', () => {
  it('says clearly when no Team Brain is set up', async () => {
    expect((await call(askTeamBrainTool, { question: 'Who are we?' }, person('alice'))).error).toMatch(/no Team Brain set up/)
  })

  it('asks the Team Brain agent once one is set up', async () => {
    await mutateSettings((settings) => { settings.teamBrain = { agentSlug: 'alpha', volumeId: 'v1' } })
    expect((await call(askTeamBrainTool, { question: 'Who are we?' }, person('alice'))).value).toMatchObject({ agent: 'alpha', status: 'completed', last_message: 'Reply to: Who are we?' })
  })
})

describe('the audit row', () => {
  it('one per call: who, which client, which tool, what it acted on; never the prompt, a file name, a token or a URL', async () => {
    const tools = registered(person('alice'))
    await tools('invoke_agent', { agent: 'alpha', prompt: 'TOP SECRET PROMPT' }, 'Codex')
    await tools('prepare_file_upload', { agent: 'alpha', filename: 'private-name.txt' }, 'Codex')
    await tools('get_guide', {}, null)
    await tools('invoke_agent', { agent: 'nope', prompt: 'x' }, 'Codex')
    const rows = await auditRows()
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row.details.tool)).toEqual(['invoke_agent', 'prepare_file_upload', 'get_guide', 'invoke_agent'])
    expect(rows[0]).toMatchObject({ userId: 'alice', object: 'mcp_tool', action: 'called', objectId: 'alpha' })
    expect(rows[0].details).toEqual({ tool: 'invoke_agent', client: 'Codex', credential: 'installation-token', agent: 'alpha', session_id: expect.any(String), outcome: 'ok' })
    expect(rows[2]).toMatchObject({ objectId: 'get_guide', details: { client: null, outcome: 'ok' } })
    expect(rows[3].details).toMatchObject({ agent: 'nope', outcome: 'error' })
    const all = JSON.stringify(rows)
    for (const secret of ['TOP SECRET PROMPT', 'private-name', 'signed-files', 'gamut_mcp_']) expect(all).not.toContain(secret)
  })
})

describe('the rate limit', () => {
  it(`admits ${MCP_TOOL_CALLS_PER_MINUTE} calls a minute per person, then answers a tool error saying when to retry; another person is not affected`, async () => {
    const alice = registered(person('alice'))
    for (let i = 0; i < MCP_TOOL_CALLS_PER_MINUTE; i++) expect((await alice('get_guide', {})).isError).toBeFalsy()
    const refused = await alice('get_guide', {})
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toMatch(/Rate limit: at most 120 Gamut tool calls a minute\. Nothing was done\. Wait (\d+) seconds/)
    const wait = Number(/Wait (\d+) seconds/.exec(refused.content[0].text)![1])
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(60)
    // A refused call is not run and writes no audit row.
    expect(await auditRows()).toHaveLength(MCP_TOOL_CALLS_PER_MINUTE)
    expect((await registered(person('bob'))('get_guide', {})).isError).toBeFalsy()
  })

  it('opens a new window once the minute is over', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const alice = registered(person('alice'))
      for (let i = 0; i < MCP_TOOL_CALLS_PER_MINUTE; i++) await alice('get_guide', {})
      expect((await alice('get_guide', {})).isError).toBe(true)
      vi.setSystemTime(Date.now() + 61_000)
      expect((await alice('get_guide', {})).isError).toBeFalsy()
    } finally {
      vi.useRealTimers()
    }
  })
})

// get_guide stays callable directly (the registry is what counts and audits).
it('get_guide runs outside the registry without a call context', async () => {
  expect((await call(getGuide, {}, person('alice'))).value.topic).toBe('overview')
})

describe('review fixes', () => {
  it('a session MCP did not start keeps its origin when continued, and a user-role member may continue another person\'s session as the app\'s message route allows', async () => {
    // A person's interactive session (origin user), and an agent's call.
    fake.state.sessions.set('bobs-chat', fake.blank('bobs-chat', 'alpha', 'Bob chat', { createdByUserId: 'bob' }))
    fake.state.sessions.set('agent-call', fake.blank('agent-call', 'alpha', 'Invoked by Beta', { invokedByAgentSlug: 'beta' }))
    // The app's POST /api/agents/:id/sessions/:sessionId/messages is AgentUser()
    // plus "the session is the agent's": any user-role member may post into any session.
    expect((await call(invokeAgentTool, { agent: 'alpha', session_id: 'bobs-chat', prompt: 'hello' }, person('alice'))).value.status).toBe('completed')
    expect((await call(invokeAgentTool, { agent: 'alpha', session_id: 'bobs-chat', prompt: 'hello' }, person('victor'))).error).toMatch(/needs the user role or higher/)
    expect((await call(invokeAgentTool, { agent: 'alpha', session_id: 'bobs-chat', prompt: 'hello' }, person('nobody'))).error).toMatch(/Agent not found/)
    expect((await call(invokeAgentTool, { agent: 'alpha', session_id: 'agent-call', prompt: 'hello' }, person('alice'))).value.status).toBe('completed')
    expect(fake.state.sessions.get('bobs-chat')!.metadata).toEqual({ createdByUserId: 'bob' })
    expect(sessionOrigin(fake.state.sessions.get('bobs-chat')!.metadata as SessionMetadata)).toBe('user')
    expect(sessionOrigin(fake.state.sessions.get('agent-call')!.metadata as SessionMetadata)).toBe('agent')
    // Still what list_sessions (the app's list) shows.
    const ids = (await call(listSessions, { agent: 'alpha' }, person('alice'))).value.sessions.map((s: { session_id: string }) => s.session_id)
    expect(ids).toContain('bobs-chat')
  })

  it('a delivery whose turn has not begun is not reported settled: it waits for the reply (past the reply-flush poll)', async () => {
    const started = Date.now()
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Begin later [late]', wait_seconds: 10 }, person('alice'))
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_900)
    expect(value).toMatchObject({ status: 'completed', last_message: 'Late but here' })
  })

  it('a delivery whose turn never begins answers running at the deadline, not completed', async () => {
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Never [never]', wait_seconds: 1 }, person('alice'))
    expect(value.status).toBe('running')
    expect(value.last_message).toBeNull()
  })

  it('a card with several questions, or a question beside another request, is not answered here: the link and every question', async () => {
    const asked = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Ask two [questions]' }, person('alice'))).value
    expect(asked.status).toBe('awaiting_input')
    expect(asked.pending_request).toMatchObject({ kind: 'question', text: 'Which colour? (options: Red, Blue)\nWhich shade? (options: Red, Blue)' })
    expect(asked.note).toMatch(/several questions/)
    const again = (await call(invokeAgentTool, { agent: 'alpha', session_id: asked.session_id, prompt: 'Blue' }, person('alice'))).value
    expect(again.status).toBe('awaiting_input')
    expect(again.note).toMatch(/NOT delivered/)
    expect(fake.state.answers).toEqual([])
    expect(fake.state.sessions.get(asked.session_id)!.prompts).toEqual(['Ask two [questions]'])

    const mixed = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Ask and need [question+secret]' }, person('alice'))).value
    expect(mixed.pending_request.kind).toBe('secret')
    expect((await call(invokeAgentTool, { agent: 'alpha', session_id: mixed.session_id, prompt: 'Blue' }, person('alice'))).value.note).toMatch(/NOT delivered/)
    expect(fake.state.answers).toEqual([])
  })

  it('last_message is the agent\'s last real text, never a tool-use placeholder, while it waits or works', async () => {
    const asked = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Paint it [question]' }, person('alice'))).value
    expect(asked.last_message).toBe('Let me ask you.')
    const working = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Long [slow]', wait_seconds: 0 }, person('alice'))).value
    expect(working).toMatchObject({ status: 'running', last_message: 'Working on it, step 1 done.' })
    const fresh = (await call(invokeAgentTool, { agent: 'alpha', prompt: 'Long again [slow]', wait_seconds: 0 }, person('alice'))).value
    // Nothing from an earlier turn: a session that has written no text yet says null.
    fake.state.sessions.get(fresh.session_id)!.entries = fake.state.sessions.get(fresh.session_id)!.entries.filter((entry) => entry.kind === 'user' || entry.toolOnly)
    expect((await call(waitForSessionTool, { agent: 'alpha', session_id: fresh.session_id, wait_seconds: 0 }, person('alice'))).value.last_message).toBeNull()
  })

  it('the rate limit is checked before the scope: once the window is full, scope refusals write no audit rows', async () => {
    const alice = registered(person('alice'))
    for (let i = 0; i < MCP_TOOL_CALLS_PER_MINUTE; i++) await alice('get_guide', {})
    const before = (await auditRows()).length
    const readOnly = registered({ ...person('alice'), scopes: ['read'] })
    for (let i = 0; i < 5; i++) {
      const refused = await readOnly('invoke_agent', { agent: 'alpha', prompt: 'hi' })
      expect(refused.content[0].text).toMatch(/Rate limit/)
    }
    expect(await auditRows()).toHaveLength(before)
  })

  it('a failed delivery says the attached uploads were used up; they cannot be attached again', async () => {
    const prepared = (await call(prepareFileUpload, { agent: 'alpha', filename: 'a.txt' }, person('alice'))).value
    const grant = await authorizeSignedFileRequest(prepared.upload_url.split('/').pop()!, 'upload')
    await storeSignedUpload(grant, new Response('x').body, 1)
    const failed = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Send [refuse]', attachments: [prepared.upload_id] }, person('alice'))
    expect(failed.error).toContain(`The attached uploads (${prepared.upload_id}) were used up by this call: upload the files again`)
    expect((await call(invokeAgentTool, { agent: 'alpha', prompt: 'Retry', attachments: [prepared.upload_id] }, person('alice'))).error).toMatch(/not a finished upload/)
  })

  it('an abort before delivery sends nothing and spends no upload; an abort during delivery still delivers, and never stops the turn', async () => {
    const prepared = (await call(prepareFileUpload, { agent: 'alpha', filename: 'a.txt' }, person('alice'))).value
    const grant = await authorizeSignedFileRequest(prepared.upload_url.split('/').pop()!, 'upload')
    await storeSignedUpload(grant, new Response('x').body, 1)
    const gone = new AbortController()
    gone.abort()
    const early = await call(invokeAgentTool, { agent: 'alpha', prompt: 'hi', attachments: [prepared.upload_id] }, person('alice'), { signal: gone.signal })
    expect(early.error).toMatch(/cancelled before anything was sent/)
    expect(fake.state.sessions.size).toBe(0)

    const leaving = new AbortController()
    setTimeout(() => leaving.abort(), 50)
    const during = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Work [slow-deliver] [slow]', attachments: [prepared.upload_id] }, person('alice'), { signal: leaving.signal })
    expect(during.value.status).toBe('running')
    const session = fake.state.sessions.get(during.value.session_id)!
    // Created with its prompt (and the attachment), and still working.
    expect(session.prompts).toHaveLength(1)
    expect(session.prompts[0]).toMatch(/^Work \[slow-deliver\] \[slow\]\n\n.*\/workspace\/uploads\/a-/s)
    expect(session.active).toBe(true)
  })
})

describe('progress', () => {
  it('counts from the call\'s start, so a slow delivery still leaves a tick inside a short wait; nothing is sent after the result', async () => {
    const ticks: Array<{ progress: number; total: number | undefined; message: string }> = []
    const progress = async (value: number, total: number | undefined, message: string) => { ticks.push({ progress: value, total, message }) }
    // Delivery takes 2s and the wait is 6s: a clock started at delivery would
    // first tick at 7s, after the call answered.
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Cold start [cold] [slow]', wait_seconds: 6 }, person('alice'), { progress })
    expect(value.status).toBe('running')
    expect(ticks).toEqual([{ progress: 5, total: 6, message: 'The agent is working (5s)' }])
    await new Promise((resolve) => setTimeout(resolve, 5_500))
    expect(ticks).toHaveLength(1)
  }, 20_000)

  it('wait_for_session ticks on its own call\'s clock too', async () => {
    const { value } = await call(invokeAgentTool, { agent: 'alpha', prompt: 'Long [slow]', wait_seconds: 0 }, person('alice'))
    const ticks: number[] = []
    await call(waitForSessionTool, { agent: 'alpha', session_id: value.session_id, wait_seconds: 6 }, person('alice'), { progress: async (elapsed: number) => { ticks.push(elapsed) } })
    expect(ticks).toEqual([5])
  }, 20_000)
})

describe('analytics', () => {
  const events = (name: string) => analytics.track.mock.calls.filter(([event]) => event === name).map(([, properties]) => properties)
  const SECRET = 'TOP SECRET PROMPT 4417'

  it('mcp_tool_called: one per call that ran, with tool, client, credential, era and outcome, and nothing it acted on', async () => {
    const tools = registered(person('alice'), 'modern')
    const result = await tools('invoke_agent', { agent: 'alpha', prompt: SECRET }, 'Codex')
    await tools('invoke_agent', { agent: 'nope', prompt: SECRET }, null)
    expect(events('mcp_tool_called')).toEqual([
      { tool: 'invoke_agent', client_name: 'Codex', credential: 'installation-token', protocol_era: 'modern', outcome: 'ok' },
      { tool: 'invoke_agent', client_name: null, credential: 'installation-token', protocol_era: 'modern', outcome: 'error' },
    ])
    // No era known: the property is left out.
    await registered(person('alice'))('get_guide', {}, null)
    expect(events('mcp_tool_called').at(-1)).toEqual({ tool: 'get_guide', client_name: null, credential: 'installation-token', outcome: 'ok' })
    const serialized = JSON.stringify(analytics.track.mock.calls)
    for (const sensitive of [SECRET, 'alpha', 'alice', result.structuredContent.session_id, 'gamut.test']) expect(serialized).not.toContain(sensitive)
  })

  it('a call refused by the rate limit sends nothing', async () => {
    const alice = registered(person('alice'))
    for (let i = 0; i < MCP_TOOL_CALLS_PER_MINUTE; i++) await alice('get_guide', {})
    analytics.track.mockClear()
    expect((await alice('get_guide', {})).isError).toBe(true)
    expect((await alice('invoke_agent', { agent: 'alpha', prompt: 'hi' })).isError).toBe(true)
    expect(analytics.track).not.toHaveBeenCalled()
  })

  it('mcp_session_started: a new session only, with client, credential, Team Brain and attachments flags', async () => {
    const tools = registered(person('alice'), 'legacy')
    const first = await tools('invoke_agent', { agent: 'alpha', prompt: SECRET }, 'Claude Code')
    expect(events('mcp_session_started')).toEqual([
      { client_name: 'Claude Code', credential: 'installation-token', is_team_brain: false, has_attachments: false },
    ])
    // Continuing it starts nothing.
    await tools('invoke_agent', { agent: 'alpha', prompt: 'again', session_id: first.structuredContent.session_id }, 'Claude Code')
    expect(events('mcp_session_started')).toHaveLength(1)

    // The Team Brain, and a session with an attachment.
    await mutateSettings((settings) => { settings.teamBrain = { agentSlug: 'beta', volumeId: 'v1' } })
    await tools('ask_team_brain', { question: SECRET }, null)
    const prepared = (await call(prepareFileUpload, { agent: 'alpha', filename: 'secret-name.txt' }, person('alice'))).value
    const grant = await authorizeSignedFileRequest(prepared.upload_url.split('/').pop()!, 'upload')
    await storeSignedUpload(grant, new Response('x').body, 1)
    await tools('invoke_agent', { agent: 'alpha', prompt: SECRET, attachments: [prepared.upload_id] }, null)
    expect(events('mcp_session_started').slice(1)).toEqual([
      { client_name: null, credential: 'installation-token', is_team_brain: true, has_attachments: false },
      { client_name: null, credential: 'installation-token', is_team_brain: false, has_attachments: true },
    ])
    const serialized = JSON.stringify(analytics.track.mock.calls)
    for (const sensitive of [SECRET, 'alpha', 'beta', 'alice', 'secret-name', first.structuredContent.session_id, prepared.upload_id]) {
      expect(serialized).not.toContain(sensitive)
    }
  })
})
