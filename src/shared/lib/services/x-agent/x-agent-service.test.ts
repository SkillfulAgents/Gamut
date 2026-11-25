/**
 * The x-agent service seen from its callers: the per-call sync wait, and the
 * user caller's authorization (its own agent_acl role, no policy, no review).
 * The agent-facing wire contract is pinned by src/api/routes/x-agent.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'crypto'
import * as schema from '../../db/schema'
import type { AppDatabase } from '../../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../../db/testing/create-test-database'
import type { AgentRole } from '@shared/lib/types/agent'
import { getDefaultUserSettings } from '@shared/lib/services/user-settings-service'

// The configured sync wait is read when sync-wait.ts loads. Pin it to the
// default (unset) before any import, whatever the shell sets, so the tests
// below can assume a 120s maximum; tests that need another configured wait
// load the service again under it (loadWithConfiguredWait).
vi.hoisted(() => {
  vi.stubEnv('X_AGENT_SYNC_WAIT_TIMEOUT_MS', undefined)
})
afterAll(() => {
  vi.unstubAllEnvs()
})

let testDb: AppDatabase
let handle: TestDatabase

vi.mock('@shared/lib/db', () => ({
  get db() { return testDb },
}))

let authModeEnabled = false
vi.mock('@shared/lib/auth/mode', () => ({
  isAuthMode: () => authModeEnabled,
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

const { mockEvaluatePolicy, mockRequestXAgent } = vi.hoisted(() => ({
  mockEvaluatePolicy: vi.fn(async (..._args: unknown[]): Promise<'allow' | 'block' | 'review'> => 'allow'),
  mockRequestXAgent: vi.fn(),
}))
vi.mock('@shared/lib/services/x-agent-policy-service', () => ({
  evaluate: (...args: unknown[]) => mockEvaluatePolicy(...args),
}))

vi.mock('@shared/lib/services/agent-service', () => ({
  listAgents: async () => [
    { slug: TARGET, name: 'Target', description: 'the target' },
    { slug: OTHER, name: 'Other', description: 'another agent' },
  ],
  getAgentRecord: async (slug: string) => ({ slug, name: slug }),
}))

// A new session's start: settings, secrets and the model resolve, all neutral.
vi.mock('@shared/lib/config/settings', () => ({ getSettings: async () => ({ app: {} }) }))
vi.mock('@shared/lib/services/secrets-service', () => ({ getSecretEnvVars: async () => [] }))
vi.mock('@shared/lib/llm-provider/connection-runtime', () => ({ bindAgentModelChoice: async () => ({}) }))
vi.mock('@shared/lib/services/session-defaults', () => ({
  resolveSessionDefaults: async () => ({
    agentPrefs: {},
    agentLimits: {},
    customEnvVars: undefined,
    maxBrowserTabs: undefined,
    models: {},
    resolve: async () => ({ model: 'sonnet' }),
  }),
}))
vi.mock('@shared/lib/notifications/global-feed', () => ({ globalFeed: { publish: vi.fn() } }))

const TARGET = 'target-agent'
const OTHER = 'other-agent'
const CALLER_AGENT = 'caller-agent'
const USER_ID = 'user-1'
const SESSION_ID = 'session-1'
const NEW_SESSION_ID = 'session-new'

// The target agent, as the operations reach it.
const mockWaitForIdle = vi.fn(async (..._args: unknown[]): Promise<'idle' | 'timeout'> => 'idle')
const mockDeliver = vi.fn(async (..._args: unknown[]) => {})
const mockIsActive = vi.fn(() => false)
const mockStart = vi.fn(async (..._args: unknown[]) => ({ id: NEW_SESSION_ID }))
const fakeActor = {
  container: { start: vi.fn(async () => {}) },
  files: {
    readSized: vi.fn(async () => ({ size: 4, stream: new Blob(['data']).stream() })),
  },
  live: async () => ({ activeSessionIds: [] as string[] }),
  listing: async () => ({
    live: { activeSessionIds: [], awaitingSessionIds: [], pendingReviews: [] },
    sessions: { sessionIds: [], sessionCount: 0, lastActivityAt: null, metadata: {} },
    artifacts: { dashboards: [], widgets: [] },
  }),
  inputs: { reviews: { requestXAgent: (...args: unknown[]) => mockRequestXAgent(...args) } },
  sessions: {
    isKnown: vi.fn(async () => true),
    attach: vi.fn(async () => {}),
    metadata: vi.fn(async () => null),
    recordInvocation: vi.fn(async (..._args: unknown[]) => {}),
    list: vi.fn(async () => [{ id: SESSION_ID, name: 'A session', createdAt: new Date(0), lastActivityAt: new Date(0) }]),
    live: vi.fn(async () => ({ isActive: mockIsActive(), isAwaitingInput: false })),
    waitForIdle: (...args: unknown[]) => mockWaitForIdle(...args),
    start: (...args: unknown[]) => mockStart(...args),
  },
  messages: {
    broadcastEvent: vi.fn(async () => {}),
    findLastEntry: vi.fn(async () => undefined),
    deliver: (...args: unknown[]) => mockDeliver(...args),
    transcriptView: vi.fn(async () => ({ messages: [], total: 0, deliveredFiles: [] })),
    findDeliveredFile: vi.fn(async () => ({ id: 'd1', filename: 'out.txt', sizeBytes: 4, filePath: '/workspace/out.txt' })),
  },
}

vi.mock('@shared/lib/agent-actor', () => ({
  agentCatalog: {
    resolveRecord: async (slug: string) => ([TARGET, OTHER, CALLER_AGENT].includes(slug) ? { slug, name: slug } : null),
  },
  agentRegistry: { get: () => fakeActor },
}))

import { userXAgentCaller, agentXAgentCaller, type XAgentCaller } from './caller'
import { getTargetSessions, getTargetTranscript, listVisibleAgents, openDeliveredFile, toListedAgent, toListedSections } from './operations'
import { invokeAgent } from './invoke'
import { effectiveSyncWaitMs, readLastAssistantMessage, readLastAssistantReply } from './sync-wait'
import { applySidebarFile, SectionChangeRefused, sidebarFileOf, type SidebarScope } from './sidebar-sections'

async function seedRole(userId: string, agentSlug: string, role: AgentRole) {
  await testDb.insert(schema.agentAcl).values({ id: randomUUID(), userId, agentSlug, role, createdAt: new Date() })
}

/** The service loaded afresh with the given configured wait (the env override). */
async function loadWithConfiguredWait(raw: string) {
  vi.resetModules()
  vi.stubEnv('X_AGENT_SYNC_WAIT_TIMEOUT_MS', raw)
  try {
    const { invokeAgent: invoke } = await import('./invoke')
    const callers = await import('./caller')
    return { invoke, agentCaller: callers.agentXAgentCaller, userCaller: callers.userXAgentCaller }
  } finally {
    vi.stubEnv('X_AGENT_SYNC_WAIT_TIMEOUT_MS', undefined)
  }
}

/** The promoted note exactly as the agent route has always worded it. */
function routeNote(seconds: string): string {
  return (
    `Sync wait timed out after ${seconds}, but the target agent is still ` +
    'working on this prompt. Do NOT re-invoke — that would start a duplicate run. ' +
    'Poll get_agent_session_transcript with this session_id to retrieve the result.'
  )
}

/** What the operation handed the target's sessions.start. */
function lastStart(): { name: string; metadata: Record<string, unknown> } {
  return mockStart.mock.calls.at(-1)?.[0] as { name: string; metadata: Record<string, unknown> }
}

/** The timeoutMs the operation handed the target's waitForIdle. */
function lastWaitTimeoutMs(): number {
  const options = mockWaitForIdle.mock.calls.at(-1)?.[1] as { timeoutMs: number }
  return options.timeoutMs
}

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(schema.user).values([
    { id: USER_ID, name: 'User', email: 'user@test', emailVerified: false },
  ])
  await testDb.insert(schema.agents).values(
    [TARGET, OTHER, CALLER_AGENT].map((slug) => ({ slug, name: slug, createdAt: new Date(), runtime: 'local' })),
  )
  authModeEnabled = false
  vi.clearAllMocks()
  mockWaitForIdle.mockResolvedValue('idle')
  mockIsActive.mockReturnValue(false)
  mockEvaluatePolicy.mockResolvedValue('allow')
  mockStart.mockResolvedValue({ id: NEW_SESSION_ID })
})

afterEach(async () => {
  await handle.close()
})

describe('caller session invocation references', () => {
  const caller = agentXAgentCaller(CALLER_AGENT, 'calling-session')

  it.each([
    [undefined, NEW_SESSION_ID],
    [SESSION_ID, SESSION_ID],
  ])('records an accepted call to %s before waiting for its reply', async (sessionId, expectedId) => {
    const result = await invokeAgent(caller, { slug: TARGET, prompt: 'Research the topic', sessionId, sync: true, callerToolUseId: 'tool-123' })
    expect(result.ok).toBe(true)
    expect(fakeActor.sessions.recordInvocation).toHaveBeenCalledWith('calling-session', {
      agentSlug: TARGET, sessionId: expectedId, toolUseId: 'tool-123', prompt: 'Research the topic', calledAt: expect.any(String),
    })
    expect(fakeActor.sessions.recordInvocation.mock.invocationCallOrder[0]).toBeLessThan(mockWaitForIdle.mock.invocationCallOrder[0])
    expect(fakeActor.messages.broadcastEvent).toHaveBeenCalledWith('calling-session', { type: 'agent_invoked' })
    expect(fakeActor.messages.broadcastEvent.mock.invocationCallOrder[0]).toBeLessThan(mockWaitForIdle.mock.invocationCallOrder[0])
  })

  it('keeps self-invocations in history without asking the tray to open', async () => {
    const result = await invokeAgent(caller, { slug: CALLER_AGENT, prompt: 'Start a worker', sync: false })
    expect(result.ok).toBe(true)
    expect(fakeActor.sessions.recordInvocation).toHaveBeenCalledOnce()
    expect(fakeActor.messages.broadcastEvent).not.toHaveBeenCalled()
  })

  it('creates no reference when the continuation cannot be delivered', async () => {
    mockDeliver.mockRejectedValueOnce(new Error('Container unavailable'))
    const result = await invokeAgent(caller, { slug: TARGET, prompt: 'Continue', sessionId: SESSION_ID })
    expect(result.ok).toBe(false)
    expect(fakeActor.sessions.recordInvocation).not.toHaveBeenCalled()
    expect(fakeActor.messages.broadcastEvent).not.toHaveBeenCalled()
  })
})

describe('the sync wait a caller asks for', () => {
  const caller = () => userXAgentCaller({ userId: USER_ID })

  it('is the configured maximum when the caller asks for none', () => {
    expect(effectiveSyncWaitMs(undefined)).toBe(120_000)
    expect(effectiveSyncWaitMs(0)).toBe(120_000)
    expect(effectiveSyncWaitMs(-1)).toBe(120_000)
    expect(effectiveSyncWaitMs(Number.NaN)).toBe(120_000)
  })

  it('is clamped to the configured maximum', () => {
    expect(effectiveSyncWaitMs(5_000)).toBe(5_000)
    expect(effectiveSyncWaitMs(600_000)).toBe(120_000)
    expect(effectiveSyncWaitMs(Number.POSITIVE_INFINITY)).toBe(120_000)
  })

  it('a shorter wait bounds the invoke and is the one the promoted note states', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 5_000 })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(0)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(5_000)
    expect(result).toEqual({ ok: true, value: {
      sessionId: SESSION_ID,
      status: 'running',
      error: expect.stringContaining('Sync wait timed out after 5s'),
    } })
  })

  it('a wait past the maximum is clamped to it', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 10_000_000 })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)
    expect(result.ok && 'error' in result.value && result.value.error).toContain('Sync wait timed out after 120s')
  })

  it('no wait given is the default, as before', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)
    expect(result.ok && 'error' in result.value && result.value.error).toContain('Sync wait timed out after 120s')
  })

  it('a new session states the caller-supplied wait in its promoted note', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sync: true, syncWaitMs: 3_000 })
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(3_000)
    expect(result).toEqual({ ok: true, value: {
      sessionId: NEW_SESSION_ID,
      status: 'running',
      error: expect.stringContaining('Sync wait timed out after 3s,'),
    } })
  })

  it('a sub-second wait is stated in ms, never as 0s', async () => {
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const result = await invokeAgent(caller(), { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 400 })
    expect(result.ok && 'error' in result.value && result.value.error).toContain('Sync wait timed out after 400ms,')
  })

  it('bounds a sync transcript read the same way', async () => {
    mockIsActive.mockReturnValue(true)
    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const short = await getTargetTranscript(caller(), { slug: TARGET, sessionId: SESSION_ID, sync: true, syncWaitMs: 2_000 })
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(2_000)
    expect(short).toMatchObject({ ok: true, value: { status: 'running' } })

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    await getTargetTranscript(caller(), { slug: TARGET, sessionId: SESSION_ID, sync: true, syncWaitMs: 900_000 })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    await getTargetTranscript(caller(), { slug: TARGET, sessionId: SESSION_ID, sync: true })
    expect(lastWaitTimeoutMs()).toBeGreaterThan(100_000)
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(120_000)
  })
})

describe('a user caller is authorized by its own role on the target', () => {
  beforeEach(() => {
    authModeEnabled = true
  })

  const user = (isAdmin = false): XAgentCaller => userXAgentCaller({ userId: USER_ID, isAdmin })
  const read = (caller: XAgentCaller) => getTargetSessions(caller, { slug: TARGET, limit: 50, offset: 0 })
  const transcript = (caller: XAgentCaller) => getTargetTranscript(caller, { slug: TARGET, sessionId: SESSION_ID })
  const invoke = (caller: XAgentCaller) => invokeAgent(caller, { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID })

  it('a viewer can read sessions and transcripts but not invoke', async () => {
    await seedRole(USER_ID, TARGET, 'viewer')
    expect((await read(user())).ok).toBe(true)
    expect((await transcript(user())).ok).toBe(true)
    expect(await invoke(user())).toEqual({ ok: false, status: 403, error: 'Forbidden: caller has no user access to target agent' })
    expect(mockDeliver).not.toHaveBeenCalled()
  })

  it('a user can invoke', async () => {
    await seedRole(USER_ID, TARGET, 'user')
    expect(await invoke(user())).toEqual({ ok: true, value: { sessionId: SESSION_ID, status: 'running' } })
    expect(mockDeliver).toHaveBeenCalledTimes(1)
  })

  it('no role on the target is refused everywhere', async () => {
    await seedRole(USER_ID, OTHER, 'owner')
    const refused = { ok: false, status: 403, error: 'Forbidden: caller has no access to target agent' }
    expect(await read(user())).toEqual(refused)
    expect(await transcript(user())).toEqual(refused)
    expect(await openDeliveredFile(user(), { slug: TARGET, sessionId: SESSION_ID, deliveryId: 'd1' })).toEqual(refused)
    expect(await invoke(user())).toEqual({ ok: false, status: 403, error: 'Forbidden: caller has no user access to target agent' })
  })

  it('lists only the agents the user can read', async () => {
    await seedRole(USER_ID, TARGET, 'viewer')
    const result = await listVisibleAgents(user())
    expect(result.ok && result.value.agents.map((a) => a.name)).toEqual(['Target'])
  })

  it('an admin passes without a role', async () => {
    expect((await read(user(true))).ok).toBe(true)
    expect((await invoke(user(true))).ok).toBe(true)
  })

  it('the local user passes in non-auth mode', async () => {
    authModeEnabled = false
    const local = userXAgentCaller({ userId: 'local' })
    expect((await read(local)).ok).toBe(true)
    expect((await invoke(local)).ok).toBe(true)
  })

  it('a user caller can download a delivered file it can read', async () => {
    await seedRole(USER_ID, TARGET, 'viewer')
    const result = await openDeliveredFile(user(), { slug: TARGET, sessionId: SESSION_ID, deliveryId: 'd1' })
    if (!result.ok) throw new Error(result.error)
    expect(result.value.filename).toBe('out.txt')
    expect(result.value.sizeBytes).toBe(4)
    expect(await new Response(result.value.body).text()).toBe('data')
  })

  it('refuses attachments from a user caller', async () => {
    await seedRole(USER_ID, TARGET, 'user')
    expect(await invokeAgent(user(), { slug: TARGET, prompt: 'hi', attachments: ['/workspace/a.txt'] }))
      .toEqual({ ok: false, status: 400, error: 'Attachments can only be sent by an agent.' })
    expect(mockStart).not.toHaveBeenCalled()
  })

  it('a user caller must name its target', async () => {
    await seedRole(USER_ID, TARGET, 'owner')
    expect(await invokeAgent(user(), { prompt: 'hi' })).toEqual({ ok: false, status: 404, error: 'Target agent not found' })
  })

  it('no agent policy is consulted and no review is raised', async () => {
    await seedRole(USER_ID, TARGET, 'owner')
    mockEvaluatePolicy.mockResolvedValue('block')
    expect((await listVisibleAgents(user())).ok).toBe(true)
    expect((await read(user())).ok).toBe(true)
    expect((await transcript(user())).ok).toBe(true)
    expect((await invoke(user())).ok).toBe(true)
    expect(mockEvaluatePolicy).not.toHaveBeenCalled()
    expect(mockRequestXAgent).not.toHaveBeenCalled()
  })

  it('an agent caller, by contrast, is held to the policy', async () => {
    await seedRole(USER_ID, CALLER_AGENT, 'owner')
    await seedRole(USER_ID, TARGET, 'owner')
    mockEvaluatePolicy.mockResolvedValue('block')
    expect(await read(agentXAgentCaller(CALLER_AGENT))).toEqual({ ok: false, status: 403, error: 'Blocked by policy' })
    expect(mockEvaluatePolicy).toHaveBeenCalled()
  })
})

describe('a user caller starting a new session', () => {
  beforeEach(async () => {
    authModeEnabled = true
    await seedRole(USER_ID, TARGET, 'user')
  })

  it('names and registers it with the neutral defaults, created by and attributed to the user', async () => {
    const result = await invokeAgent(userXAgentCaller({ userId: USER_ID }), { slug: TARGET, prompt: 'hi' })
    expect(result).toEqual({ ok: true, value: { sessionId: NEW_SESSION_ID, status: 'running' } })
    expect(lastStart().name).toBe('New session')
    expect(lastStart().metadata).toEqual({ createdByUserId: USER_ID })
    const authors = await testDb.select().from(schema.messageAuthor).all()
    expect(authors).toHaveLength(1)
    expect(authors[0]).toMatchObject({ sessionId: NEW_SESSION_ID, agentSlug: TARGET, userId: USER_ID, billedUserId: null, authorAgentSlug: null })
  })

  it('takes the name and metadata the caller supplies', async () => {
    const caller = userXAgentCaller({ userId: USER_ID, sessionName: 'From MCP', sessionMetadata: { starred: true } })
    await invokeAgent(caller, { slug: TARGET, prompt: 'hi' })
    expect(lastStart().name).toBe('From MCP')
    expect(lastStart().metadata).toEqual({ starred: true, createdByUserId: USER_ID })
  })

  it('drops the service-owned keys from supplied metadata', async () => {
    const caller = userXAgentCaller({
      userId: USER_ID,
      sessionMetadata: { invokedByAgentSlug: CALLER_AGENT, createdByUserId: 'someone-else', starred: true },
    })
    await invokeAgent(caller, { slug: TARGET, prompt: 'hi' })
    expect(lastStart().metadata).toEqual({ starred: true, createdByUserId: USER_ID })
  })

  it('a message to an existing session carries none of the caller\'s metadata: the session keeps its own origin', async () => {
    const caller = userXAgentCaller({ userId: USER_ID, sessionName: 'From MCP', sessionMetadata: { mcpInvocation: { userId: USER_ID, clientName: 'Codex' } } })
    mockStart.mockClear()
    mockDeliver.mockClear()
    const result = await invokeAgent(caller, { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID })
    expect(result).toEqual({ ok: true, value: { sessionId: SESSION_ID, status: 'running' } })
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockDeliver).toHaveBeenCalledTimes(1)
    const request = mockDeliver.mock.calls[0][0] as Record<string, unknown>
    // No metadata written, no promotion, no rename: only the message goes.
    expect(request.metadataUpdates).toBeUndefined()
    expect(request.promote).toBeUndefined()
    expect(JSON.stringify(request)).not.toContain('mcpInvocation')
  })

  it('drops them even when the service has no creator to record', async () => {
    authModeEnabled = false
    const caller = userXAgentCaller({ userId: 'local', sessionMetadata: { invokedByAgentSlug: CALLER_AGENT, createdByUserId: 'someone-else' } })
    await invokeAgent(caller, { slug: TARGET, prompt: 'hi' })
    expect(lastStart().metadata).toEqual({})
  })
})

describe('the promoted note under a configured sub-second wait', () => {
  it.each([
    ['750', '1s'],
    ['400', '0s'],
  ])('an agent call configured to %sms keeps the route wording (%s) on both invoke paths', async (raw, seconds) => {
    const { invoke, agentCaller } = await loadWithConfiguredWait(raw)
    const caller = agentCaller(CALLER_AGENT, 'calling-session')

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const existing = await invoke(caller, { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true })
    expect(lastWaitTimeoutMs()).toBeLessThanOrEqual(Number(raw))
    expect(existing).toEqual({ ok: true, value: { sessionId: SESSION_ID, status: 'running', error: routeNote(seconds) } })

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const created = await invoke(caller, { slug: TARGET, prompt: 'hi', sync: true })
    expect(created).toEqual({ ok: true, value: { sessionId: NEW_SESSION_ID, status: 'running', error: routeNote(seconds) } })
  })

  it('a sub-second wait the caller chose is stated in ms on both invoke paths', async () => {
    const { invoke, userCaller } = await loadWithConfiguredWait('750')
    const caller = userCaller({ userId: USER_ID })

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const existing = await invoke(caller, { slug: TARGET, prompt: 'hi', sessionId: SESSION_ID, sync: true, syncWaitMs: 400 })
    expect(existing).toEqual({ ok: true, value: { sessionId: SESSION_ID, status: 'running', error: routeNote('400ms') } })

    mockWaitForIdle.mockResolvedValueOnce('timeout')
    const created = await invoke(caller, { slug: TARGET, prompt: 'hi', sync: true, syncWaitMs: 400 })
    expect(created).toEqual({ ok: true, value: { sessionId: NEW_SESSION_ID, status: 'running', error: routeNote('400ms') } })
  })
})

describe('the last assistant reply after a boundary', () => {
  const findLastEntry = fakeActor.messages.findLastEntry as unknown as ReturnType<typeof vi.fn>
  const assistant = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({ type: 'assistant', uuid, message: { content }, ...extra })

  afterEach(() => {
    findLastEntry.mockReset()
    findLastEntry.mockImplementation(async () => undefined)
  })

  it('reads up to the given attempts at the given interval while the boundary is still last, then gives up', async () => {
    findLastEntry.mockImplementation(async () => assistant('old', 'previous answer'))
    const started = Date.now()
    expect(await readLastAssistantReply(TARGET, SESSION_ID, { boundaryUuid: 'old', attempts: 3, intervalMs: 20 })).toBeNull()
    expect(findLastEntry).toHaveBeenCalledTimes(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it('answers the newer entry with its uuid, spoken text and API-error flag', async () => {
    findLastEntry
      .mockImplementationOnce(async () => assistant('old', 'previous answer'))
      .mockImplementationOnce(async () => assistant('new', [{ type: 'text', text: 'Overloaded' }, { type: 'tool_use', name: 'Read', id: 't', input: {} }], { isApiErrorMessage: true }))
    expect(await readLastAssistantReply(TARGET, SESSION_ID, { boundaryUuid: 'old', attempts: 3, intervalMs: 5 })).toEqual({
      uuid: 'new', role: 'assistant', content: 'Overloaded\n[tool_use: Read]', spoken: 'Overloaded', toolName: 'Read', isApiErrorMessage: true,
    })
  })

  it('counts a system entry as the reply unless told not to, as the x-agent read always has', async () => {
    findLastEntry.mockImplementation(async () => ({ type: 'system', uuid: 'sys', subtype: 'compact_boundary' }))
    expect(await readLastAssistantMessage(TARGET, SESSION_ID)).toEqual({ role: 'system', content: '[context compacted]' })
    expect(await readLastAssistantReply(TARGET, SESSION_ID, { attempts: 1, includeSystem: false })).toBeNull()
  })
})

describe('toListedAgent', () => {
  it('caps the roster at 25 with people first, counts automated sessions, and treats a pending review as needing input', () => {
    const people = Array.from({ length: 26 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, email: `p${i}@test`, image: null, role: 'user' as const, ...(i === 0 && { invited: true as const }) }))
    const agent = toListedAgent(
      { slug: TARGET, name: 'Target', avatar: { color: 'tonal-red', shape: 'squircle' }, createdAt: new Date(0), placement: { runtime: 'local', workspaceHandle: null } },
      {
        live: { container: { status: 'stopped', port: null, healthWarnings: [], stale: false, idleSince: null }, activeSessionIds: [], awaitingSessionIds: [], openRequests: [], pendingReviews: [{ id: 'r1', displayText: 'GET /x' }] },
        sessions: { sessionIds: ['s1', 's2'], sessionCount: 2, lastActivityAt: new Date(5), metadata: { s2: { isScheduledExecution: true } } },
        artifacts: { dashboards: [{ slug: 'pipeline', name: '', description: '', status: 'stopped', port: 0 }], widgets: [] },
        refreshingWidgets: [],
      },
      people,
      [{ slug: OTHER, name: 'Other', avatar: { color: 'tonal-red', shape: 'squircle' }, role: 'user', canMessage: true, readDecision: 'allow' }],
      ['gmail'],
    )
    expect(agent.members).toHaveLength(25)
    expect(agent.members.every((m) => m.kind === 'person')).toBe(true)
    expect(agent.members[0]).toEqual({ name: 'Person 0', role: 'user', invited: true, kind: 'person' })
    expect(agent).toMatchObject({ memberCount: 27, needsInput: true, running: false, sessionCount: 2, automatedSessionCount: 1, dashboards: ['pipeline'] })
    expect(JSON.stringify(agent)).not.toContain('@test')
  })
})

describe('toListedSections', () => {
  it('files agents by their stored slug, lists them by their display slug, and keeps each heading on one line', () => {
    const record = (slug: string, name: string) => ({ slug, name, avatar: { color: 'tonal-red', shape: 'squircle' } as const, createdAt: new Date(0), placement: { runtime: 'local' as const, workspaceHandle: null } })
    const sections = toListedSections(
      [record('abc123', 'Sales Desk'), record('def456', 'Research')],
      ['sales-desk-abc123', 'research-def456'],
      { name: 'Jeremy', settings: { ...getDefaultUserSettings(), agentFolders: [{ id: 'f1', name: 'Sales\n## Team' }], agentFolderAssignments: { abc123: 'f1' } } },
    )
    expect(sections).toEqual({
      personName: 'Jeremy',
      sections: [{ name: 'Your Agents', agents: ['research-def456'] }, { name: 'Sales ## Team', agents: ['sales-desk-abc123'] }],
    })
  })
})

describe('applySidebarFile', () => {
  // agent-c is in the person's sidebar but the caller cannot list it.
  const scope: SidebarScope = {
    sidebar: ['agent-a', 'agent-b', 'agent-c'].map((slug) => ({ slug, createdAt: new Date(0) })),
    shown: new Map([['agent-a', 'a-shown'], ['agent-b', 'b-shown']]),
  }
  const stored = (fields: object) => ({ ...getDefaultUserSettings(), ...fields })
  const current = stored({
    agentFolders: [{ id: 'f-sales', name: 'Sales \n Team' }, { id: 'f-ops', name: 'Ops' }],
    agentFolderAssignments: { 'agent-a': 'f-sales', 'agent-c': 'f-ops' },
    agentListOrder: ['agent-folder::root', 'agent-folder::f-sales', 'agent-folder::f-ops'],
  })
  const refusal = (run: () => unknown) => {
    try {
      run()
    } catch (error) {
      if (error instanceof SectionChangeRefused) return error.status
      throw error
    }
    return 'applied'
  }

  it('shows the person their sections with one-line names and only the agents the caller can list', () => {
    expect(sidebarFileOf(scope, current)).toEqual([
      { id: 'root', name: 'Your Agents', agents: ['b-shown'] },
      { id: 'f-sales', name: 'Sales Team', agents: ['a-shown'] },
      { id: 'f-ops', name: 'Ops', agents: [] },
    ])
  })

  it('applies a move, a new section and a reorder, keeping an untouched stored name and a hidden agent in place', () => {
    const before = sidebarFileOf(scope, current)
    const write = applySidebarFile(scope, current, before, [
      { id: 'f-ops', name: 'Ops', agents: ['b-shown'] },
      { id: 'root', name: 'Your Agents', agents: [] },
      { id: 'f-sales', name: 'Sales Team', agents: [] },
      { id: 'new-1', name: 'Later', agents: ['a-shown'] },
    ])
    expect(write.agentFolders).toEqual([{ id: 'f-ops', name: 'Ops' }, { id: 'f-sales', name: 'Sales \n Team' }, { id: 'new-1', name: 'Later' }])
    expect(write.agentFolderAssignments).toEqual({ 'agent-c': 'f-ops', 'agent-b': 'f-ops', 'agent-a': 'new-1' })
    expect(write.agentListOrder).toEqual(['agent-folder::f-ops', 'agent-folder::root', 'agent-folder::f-sales', 'agent-folder::new-1'])
  })

  it('sends an agent left out of the file to Your Agents, as deleting its section does', () => {
    const write = applySidebarFile(scope, current, sidebarFileOf(scope, current), [
      { id: 'root', name: 'Your Agents', agents: ['b-shown'] },
      { id: 'f-ops', name: 'Ops', agents: [] },
    ])
    expect(write.agentFolders).toEqual([{ id: 'f-ops', name: 'Ops' }])
    expect(write.agentFolderAssignments).toEqual({ 'agent-c': 'f-ops' })
    expect(write.agentOrder).toEqual(['agent-b', 'agent-a', 'agent-c'])
  })

  it('refuses a stale copy, an agent the caller cannot list, and deleting a section that holds one', () => {
    const before = sidebarFileOf(scope, current)
    expect(refusal(() => applySidebarFile(scope, current, null, before))).toBe(409)
    expect(refusal(() => applySidebarFile(scope, current, [...before].reverse(), before))).toBe(409)
    expect(refusal(() => applySidebarFile(scope, current, before, [{ ...before[0], agents: ['b-shown', 'agent-c'] }, before[1], before[2]]))).toBe(404)
    expect(refusal(() => applySidebarFile(scope, current, before, [before[0], before[1]]))).toBe(409)
  })
})
