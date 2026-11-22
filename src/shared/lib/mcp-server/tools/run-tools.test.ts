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
vi.mock('@shared/lib/auth/config', async (original) => ({
  ...(await original<typeof import('@shared/lib/auth/config')>()),
  getAppBaseUrl: async () => 'https://gamut.test',
}))

const fake = vi.hoisted(() => {
  interface FakeSession {
    id: string
    agent: string
    name: string
    metadata: Record<string, unknown>
    active: boolean
    awaiting: boolean
    openRequests: Array<{ id: string; kind: string; blocking: boolean; autoApproved: boolean; scope: { sessionId?: string }; payload: Record<string, unknown> }>
    assistant: Array<{ uuid: string; text: string; isApiErrorMessage?: boolean }>
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
  /** What a delivered prompt makes the fake session do. */
  function play(session: FakeSession, prompt: string) {
    session.prompts.push(prompt)
    session.active = true
    if (prompt.includes('[slow]')) return
    if (prompt.includes('[question]')) {
      session.awaiting = true
      session.openRequests = [{ id: `q-${session.id}`, kind: 'question', blocking: true, autoApproved: false, scope: { sessionId: session.id }, payload: { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] } }]
      return
    }
    if (prompt.includes('[secret]')) {
      session.awaiting = true
      session.openRequests = [{ id: `s-${session.id}`, kind: 'secret', blocking: true, autoApproved: false, scope: { sessionId: session.id }, payload: { secretName: 'API_KEY', reason: 'to call the API' } }]
      return
    }
    if (prompt.includes('[deliver]')) {
      session.delivered.push({ deliveryId: 'd1', filename: 'report.md', sizeBytes: 5, filePath: '/workspace/output/report.md' })
    }
    setTimeout(() => {
      session.assistant.push({ uuid: `a-${session.assistant.length}-${session.id}`, text: prompt.includes('[fail]') ? 'API Error: overloaded' : `Reply to: ${prompt.split('\n')[0]}`, isApiErrorMessage: prompt.includes('[fail]') })
      session.active = false
    }, 30)
  }
  return { state, play }
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
            const last = find(id)?.assistant.at(-1)
            return last ? { type: 'assistant', uuid: last.uuid, isApiErrorMessage: last.isApiErrorMessage, message: { content: last.text } } : null
          },
          transcriptView: async (id: string) => ({ messages: [], total: 0, deliveredFiles: find(id)?.delivered ?? [] }),
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
              session.assistant.push({ uuid: `a-answer-${session.id}`, text: `Thanks for ${JSON.stringify(value)}` })
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

vi.mock('@shared/lib/services/x-agent/invoke', () => ({
  invokeAgent: async (caller: { kind: string; sessionName: string; sessionMetadata: Record<string, unknown> }, input: { slug: string; prompt: string; sessionId?: string }) => {
    let session = input.sessionId ? fake.state.sessions.get(input.sessionId) : undefined
    if (!session) {
      const id = `session-${++fake.state.next}`
      session = { id, agent: input.slug, name: caller.sessionName, metadata: { ...caller.sessionMetadata, createdAt: new Date().toISOString() }, active: false, awaiting: false, openRequests: [], assistant: [], delivered: [], prompts: [] }
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
function registered(ctx: McpCallContext) {
  const handlers = new Map<string, (args: unknown, context?: ServerContext) => Promise<any>>()
  registerTools({ registerTool: (name: string, _config: unknown, handler: never) => { handlers.set(name, handler) } } as unknown as McpServer, ctx)
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
      session.assistant.push({ uuid: 'late', text: 'Done at last' })
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
    fake.state.sessions.set('regular', { id: 'regular', agent: 'alpha', name: 'Regular', metadata: {}, active: false, awaiting: false, openRequests: [], assistant: [], delivered: [], prompts: [] })
    fake.state.sessions.set('cron', { id: 'cron', agent: 'alpha', name: 'Cron', metadata: { isScheduledExecution: true }, active: false, awaiting: false, openRequests: [], assistant: [], delivered: [], prompts: [] })
    fake.state.sessions.set('promoted', { id: 'promoted', agent: 'alpha', name: 'Promoted', metadata: { mcpInvocation: { userId: 'bob', clientName: null }, promotedToInteractive: true }, active: false, awaiting: false, openRequests: [], assistant: [], delivered: [], prompts: [] })
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
