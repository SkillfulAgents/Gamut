// @libsql-must-pass
/**
 * `POST /llm-runtime/resolve` starts its four independent reads (is the
 * session known, its metadata, the agent's preferences, the settings)
 * together. This file pins that, and that the answer is the one the reads
 * gave when they ran one after another: `sequentialResolve` below is the
 * handler as it was, and every case is sent to both.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Hono, type MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { llmConnections } from '@shared/lib/db/schema'
import { connectionConfigSchema } from '@shared/lib/llm-provider/connection-schema'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import type { AppSettings } from '@shared/lib/config/settings'

type Metadata = { model?: string | null; llmProviderId?: string | null } | null
type Preferences = { defaultModel?: string; defaultLlmProviderId?: string | null } | null

const state = vi.hoisted(() => ({
  db: null as unknown,
  settings: {} as unknown,
  // The four reads, replaced per case. `wrap` sees every read start and finish.
  known: (async () => true) as () => Promise<boolean>,
  metadata: (async () => null) as () => Promise<unknown>,
  preferences: (async () => ({})) as () => Promise<unknown>,
  readSettings: null as null | (() => Promise<unknown>),
  wrap: (<T>(_name: string, read: () => Promise<T>) => read()) as <T>(name: string, read: () => Promise<T>) => Promise<T>,
  recordRuntime: vi.fn(async (_sessionId: string, _runtime: unknown) => {}),
}))
vi.mock('@shared/lib/db', () => ({
  get db() {
    return state.db
  },
}))
vi.mock('@shared/lib/config/settings', async (original) => ({
  ...(await original<typeof import('@shared/lib/config/settings')>()),
  getSettings: () => state.wrap('settings', state.readSettings ?? (async () => state.settings)),
  getEffectiveModels: () => ({ agentModel: 'model', summarizerModel: 'model' }),
  mutateSettings: (change: (s: AppSettings) => void) => change(state.settings as AppSettings),
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => undefined,
}))
vi.mock('../middleware/auth', () => ({
  IsAgent: (): MiddlewareHandler => async (c, next) => {
    c.set('agentSlug' as never, 'alpha' as never)
    return next()
  },
}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      sessions: {
        isKnown: () => state.wrap('known', state.known),
        metadata: () => state.wrap('metadata', state.metadata),
        recordRuntime: state.recordRuntime,
      },
      config: { get: () => state.wrap('preferences', state.preferences) },
    }),
  },
}))
import routes from './llm-runtime'
import { IsAgent } from '../middleware/auth'
import { agentRegistry } from '@shared/lib/agent-actor'
import { getSettings } from '@shared/lib/config/settings'
import { CredentialRefreshError } from '../../../agent-container/src/credential-refresh-error'
import { resolveConnectionCredential } from '@shared/lib/llm-provider/connection-credentials'
import { connectionRuntime } from '@shared/lib/llm-provider/connection-runtime'
import {
  saveConnection, setGlobalSelection, resolveSelectionHierarchyFrom, storedSelection,
} from '@shared/lib/llm-provider/connections'
import { BaseLlmProvider } from '@shared/lib/llm-provider/base-llm-provider'

// The handler as it was before the reads ran together: one read after another.
const sequential = new Hono()
sequential.use('*', IsAgent())
sequential.onError((error, c) => {
  if (!(error instanceof CredentialRefreshError)) throw error
  if (error.status === 503) c.header('Retry-After', '30')
  return c.json({ error: error.message, code: error.status === 401 ? 'provider_reconnect_required' : 'provider_refresh_unavailable' }, error.status)
})
const requestSchema = z.object({
  sessionId: z.string().min(1),
  llmProviderId: z.string().optional(),
  rejectedGeneration: z.number().int().optional(),
})
sequential.post('/resolve', async function sequentialResolve(c) {
  const parsed = requestSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid credential request' }, 400)
  const input = parsed.data
  const slug = c.get('agentSlug' as never) as string
  const actor = agentRegistry.get(slug)
  if (!(await actor.sessions.isKnown(input.sessionId)))
    return c.json({ error: 'Session not found' }, 404)
  const metadata = await actor.sessions.metadata(input.sessionId)
  const preferences = await actor.config.get('preferences')
  const settings = await getSettings()
  const selected = await resolveSelectionHierarchyFrom(
    settings,
    await storedSelection(metadata?.model, metadata?.llmProviderId, settings),
    await storedSelection(preferences?.defaultModel, preferences?.defaultLlmProviderId, settings)
  )
  c.header('Cache-Control', 'no-store')
  if (input.llmProviderId && input.llmProviderId !== selected.llmProviderId)
    return c.json({ error: 'Session connection changed' }, 409)
  if (input.rejectedGeneration !== undefined) await resolveConnectionCredential(selected.llmProviderId, input.rejectedGeneration)
  const runtime = await connectionRuntime(selected, slug, settings)
  await actor.sessions.recordRuntime(input.sessionId, { provider: runtime.provider })
  return c.json(runtime)
})

// A failure that reaches the app is answered with its message, so the two
// handlers can be compared on WHICH read's failure they report.
const app = new Hono()
  .route('/current', routes)
  .route('/sequential', sequential)
  .onError((error, c) => c.json({ thrown: error.message }, 500))

type Answer = { status: number; cacheControl: string | null; retryAfter: string | null; body: unknown; recorded: unknown[][]; reads: string[] }

async function ask(handler: 'current' | 'sequential', body: unknown): Promise<Answer> {
  state.recordRuntime.mockClear()
  const reads: string[] = []
  state.wrap = (name, read) => {
    reads.push(name)
    return read()
  }
  const response = await app.request(`/${handler}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    retryAfter: response.headers.get('retry-after'),
    body: await response.json(),
    recorded: state.recordRuntime.mock.calls.map(call => [...call]),
    reads,
  }
}

/** Both handlers' answers to one request; fails unless they are the same answer. */
async function both(body: unknown = { sessionId: 'session' }): Promise<Answer> {
  const before = await ask('sequential', body)
  const after = await ask('current', body)
  // Everything but which reads ran: an unknown session used to stop after the first.
  expect({ ...after, reads: null }).toEqual({ ...before, reads: null })
  return after
}

let handle: TestDatabase
let first = ''
let second = ''
const globalViewer = { userId: null, admin: true }

function account(name: string, key: string, models: string[]) {
  return saveConnection({
    name,
    provider: 'generic',
    config: { apiKeys: { genericApiKey: key, genericBaseUrl: `https://${name}.example` } },
    modelOverrides: models.map(id => ({ id, label: id, supportedEfforts: ['low'] })),
  }, globalViewer)
}

function bind(metadata: Metadata, preferences: Preferences = {}) {
  state.metadata = async () => metadata
  state.preferences = async () => preferences
}

/** The plan leaves these models out: the provider reports them as unable to run now. */
function planExcludes(...models: string[]) {
  vi.spyOn(BaseLlmProvider.prototype, 'getModelAvailability').mockImplementation(async (catalog) => {
    const unavailable = catalog.filter(m => models.includes(m.id)).map(m => ({ modelId: m.id, reason: 'Not in the plan.' }))
    return unavailable.length ? { unavailable, summary: null, action: null } : null
  })
}

beforeEach(async () => {
  handle = await createTestDatabase()
  state.db = handle.db
  state.settings = {} as AppSettings
  state.known = async () => true
  state.readSettings = null
  bind(null)
  first = await account('first', 'first-key', ['model', 'spare'])
  second = await account('second', 'second-key', ['other'])
  await setGlobalSelection('default', { llmProviderId: first, model: 'model' })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('the answer is the one the sequential reads gave', () => {
  it('a session with no binding, on an agent with no default, gets the app default', async () => {
    const answer = await both()
    expect(answer).toMatchObject({ status: 200, cacheControl: 'no-store', body: { llmProviderId: first, model: 'model', env: { ANTHROPIC_AUTH_TOKEN: 'first-key' } } })
    expect(answer.recorded).toEqual([['session', { provider: expect.any(String) }]])
  })

  it('a session with no binding gets the agent default', async () => {
    bind({}, { defaultModel: 'other', defaultLlmProviderId: second })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: second, model: 'other', env: { ANTHROPIC_AUTH_TOKEN: 'second-key' } } })
  })

  it('a session bound to a model keeps it over the agent default', async () => {
    bind({ model: 'other', llmProviderId: second }, { defaultModel: 'spare', defaultLlmProviderId: first })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: second, model: 'other' } })
  })

  it('a session bound to an account without a model gets that account\'s default', async () => {
    bind({ llmProviderId: second })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: second, model: 'other' } })
  })

  it('a legacy session that names only a model uses the migrated account from the settings', async () => {
    state.settings = { ...(state.settings as AppSettings), llmLegacyProviderId: second } as AppSettings
    bind({ model: 'other' })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: second, model: 'other' } })
  })

  it('a cleared session binding falls to the agent default', async () => {
    bind({ model: 'other', llmProviderId: null }, { defaultModel: 'spare', defaultLlmProviderId: first })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: first, model: 'spare' } })
  })

  it('a session bound to a connection that is gone falls to the agent default, then the app default', async () => {
    bind({ model: 'other', llmProviderId: 'deleted-connection' }, { defaultModel: 'other', defaultLlmProviderId: second })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: second, model: 'other' } })
    bind({ model: 'other', llmProviderId: 'deleted-connection' }, { defaultModel: 'spare', defaultLlmProviderId: 'also-deleted' })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: first, model: 'model' } })
  })

  it('a session bound to a model its connection no longer lists falls through', async () => {
    bind({ model: 'retired', llmProviderId: second })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: first, model: 'model' } })
  })

  it('a model the plan leaves out counts as unset, at every level', async () => {
    planExcludes('other')
    bind({ model: 'other', llmProviderId: second }, { defaultModel: 'spare', defaultLlmProviderId: first })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: first, model: 'spare' } })
    vi.restoreAllMocks()
    planExcludes('other', 'spare')
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: first, model: 'model' } })
    // The app default itself is left out: its connection's best runnable model stands in.
    vi.restoreAllMocks()
    planExcludes('other', 'model')
    bind({ model: 'other', llmProviderId: second })
    expect(await both()).toMatchObject({ status: 200, body: { llmProviderId: first, model: 'spare' } })
  })

  it('the container may name the connection it has, and is refused once the session moved', async () => {
    bind({ model: 'other', llmProviderId: second })
    expect((await both({ sessionId: 'session', llmProviderId: second })).status).toBe(200)
    const refused = await both({ sessionId: 'session', llmProviderId: first })
    expect(refused).toMatchObject({ status: 409, cacheControl: 'no-store', recorded: [] })
  })

  it('a rejected credential generation: a static key has nothing to refresh, a live sign-in is served, a revoked one asks for a reconnect', async () => {
    bind({ model: 'other', llmProviderId: second })
    const rejected = { sessionId: 'session', llmProviderId: second, rejectedGeneration: 7 }
    expect(await both(rejected)).toMatchObject({ status: 500, body: { thrown: expect.stringContaining('Reconnect this provider') }, recorded: [] })
    await handle.db.update(llmConnections).set({ provider: 'grok-subscription', config: JSON.stringify(connectionConfigSchema.parse({
      oauth: { accessToken: 'live-access', refreshToken: 'live-refresh', expiresAt: Date.now() + 3600000 },
    })) }).where(eq(llmConnections.id, second)).run()
    expect(await both(rejected)).toMatchObject({ status: 200, body: { proxy: { credential: { accessToken: 'live-access' } } } })
    await handle.db.update(llmConnections).set({ provider: 'grok-subscription', config: JSON.stringify(connectionConfigSchema.parse({
      oauth: { accessToken: 'revoked', refreshToken: 'revoked-refresh', expiresAt: 0, refreshFailure: { reconnectRequired: true, retryAt: 0 } },
    })) }).where(eq(llmConnections.id, second)).run()
    const refused = await both(rejected)
    expect(refused).toMatchObject({ status: 401, body: { code: 'provider_reconnect_required' }, recorded: [] })
    await handle.db.update(llmConnections).set({ config: JSON.stringify(connectionConfigSchema.parse({
      oauth: { accessToken: 'stale', refreshToken: 'stale-refresh', expiresAt: 0, refreshFailure: { reconnectRequired: false, retryAt: Date.now() + 3600000 } },
    })) }).where(eq(llmConnections.id, second)).run()
    expect(await both(rejected)).toMatchObject({ status: 503, retryAfter: '30', body: { code: 'provider_refresh_unavailable' }, recorded: [] })
  })

  it('no usable app default is the same failure', async () => {
    state.settings = {} as AppSettings
    await handle.db.delete(llmConnections).run()
    const failed = await both()
    expect(failed).toMatchObject({ status: 500, body: { thrown: expect.stringContaining('Configure a global default') }, recorded: [] })
  })

  it('an invalid request is refused before any read', async () => {
    const refused = await both({ sessionId: '' })
    expect(refused).toMatchObject({ status: 400, reads: [] })
  })
})

describe('a read that fails', () => {
  const failing = (message: string) => async () => { throw new Error(message) }

  it('an unknown session is a 404, whatever the other reads did', async () => {
    state.known = async () => false
    expect(await both()).toMatchObject({ status: 404, body: { error: 'Session not found' }, cacheControl: null, recorded: [] })
    state.metadata = failing('metadata failed')
    state.preferences = failing('preferences failed')
    state.readSettings = failing('settings failed')
    expect(await both()).toMatchObject({ status: 404, body: { error: 'Session not found' }, recorded: [] })
  })

  it.each([
    ['known', 'the session check'],
    ['metadata', 'the session metadata'],
    ['preferences', 'the agent preferences'],
    ['settings', 'the settings'],
  ] as const)('%s: a failure of %s is the failure reported', async (name, _what) => {
    if (name === 'known') state.known = failing('known failed')
    if (name === 'metadata') state.metadata = failing('metadata failed')
    if (name === 'preferences') state.preferences = failing('preferences failed')
    if (name === 'settings') state.readSettings = failing('settings failed')
    expect(await both()).toMatchObject({ status: 500, body: { thrown: `${name} failed` }, recorded: [] })
  })

  it('when several fail, the one reported is the first in the old order, not the first to fail', async () => {
    // Settings fail at once; the metadata fail later. Metadata came first.
    state.readSettings = failing('settings failed')
    state.preferences = async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      throw new Error('preferences failed')
    }
    state.metadata = async () => {
      await new Promise(resolve => setTimeout(resolve, 15))
      throw new Error('metadata failed')
    }
    expect(await both()).toMatchObject({ status: 500, body: { thrown: 'metadata failed' } })
    state.metadata = async () => null
    expect(await both()).toMatchObject({ status: 500, body: { thrown: 'preferences failed' } })
  })

  it('a failed read leaves no rejection unhandled', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      state.known = async () => false
      state.metadata = failing('metadata failed')
      state.preferences = failing('preferences failed')
      state.readSettings = failing('settings failed')
      expect((await ask('current', { sessionId: 'session' })).status).toBe(404)
      state.known = async () => true
      expect((await ask('current', { sessionId: 'session' })).status).toBe(500)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('the reads are in flight together', () => {
  /** Holds every read open until `release`, and reports which have started. */
  function held() {
    const started: string[] = []
    let open!: () => void
    const gate = new Promise<void>(resolve => { open = resolve })
    state.wrap = async (name, read) => {
      started.push(name)
      await gate
      return read()
    }
    return { started, release: open }
  }
  const send = (handler: 'current' | 'sequential') => app.request(`/${handler}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'session' }),
  })
  const idle = () => new Promise(resolve => setTimeout(resolve, 20))

  it('all four have started before any has answered', async () => {
    const reads = held()
    const response = send('current')
    await idle()
    const startedWhileHeld = [...reads.started].sort()
    reads.release()
    expect((await response).status).toBe(200)
    expect(startedWhileHeld).toEqual(['known', 'metadata', 'preferences', 'settings'])
    // Each is still read exactly once per callback.
    expect([...reads.started].sort()).toEqual(['known', 'metadata', 'preferences', 'settings'])
  })

  it('the sequential handler, held the same way, has started one: the check discriminates', async () => {
    const reads = held()
    const response = send('sequential')
    await idle()
    const startedWhileHeld = [...reads.started]
    reads.release()
    expect((await response).status).toBe(200)
    expect(startedWhileHeld).toEqual(['known'])
    expect(reads.started).toEqual(['known', 'metadata', 'preferences', 'settings'])
  })

  it('four reads of one round trip each cost the callback one wait, not four', async () => {
    const waits: number[] = []
    for (const handler of ['sequential', 'current'] as const) {
      let depth = 0
      let waitsSeen = 0
      // A wait is counted when a read starts with none in flight.
      state.wrap = async (_name, read) => {
        if (depth++ === 0) waitsSeen++
        await new Promise(resolve => setTimeout(resolve, 5))
        try { return await read() } finally { depth-- }
      }
      expect((await send(handler)).status).toBe(200)
      waits.push(waitsSeen)
    }
    expect(waits).toEqual([4, 1])
  })
})
