/**
 * GET /api/runtime-status is polled by every open window, so what it reads is
 * pinned here: the settings and the shared connections, together, and nothing
 * after them, whatever the app default points at.
 *
 * Before, it read the settings, then the default's connection row, then (when
 * that row was missing or personal) up to three more rows, one after another.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
vi.mock('@shared/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/lib/db')>()),
  get db() {
    return handle.db
  },
}))
vi.mock('@shared/lib/agent-actor', () => ({
  containerHost: { getReadiness: () => ({ status: 'READY' }) },
  hasRunningAgents: async () => false,
}))
vi.mock('@shared/lib/startup', () => ({ getServicesInitError: () => null }))

import * as records from '@shared/lib/app-records/records'
import { SETTINGS_RECORD_KEY } from '@shared/lib/app-records/record-schemas'
import { mutateSettings, type AppSettings } from '@shared/lib/config/settings'
import { llmConnections, user } from '@shared/lib/db/schema'
import { resolveGlobalSelection } from '@shared/lib/llm-provider/connections'
import { activeLlmProviderFrom } from '@shared/lib/llm-provider'
import { getSettings } from '@shared/lib/config/settings'
import runtimeStatusRoutes from './runtime-status'

const app = new Hono().route('/runtime-status', runtimeStatusRoutes)

type Session = { prepareQuery(query: { sql: string }, ...rest: unknown[]): unknown }
const session = () => (handle.db as unknown as { session: Session }).session

/** Statements sent to the driver from here on: every one is prepared by the drizzle session. */
function countStatements(): { count(): number; sql(): string[] } {
  const prepare = vi.spyOn(session(), 'prepareQuery')
  return {
    count: () => prepare.mock.calls.length,
    sql: () => prepare.mock.calls.map(([query]) => query.sql),
  }
}

async function connection(id: string, options: { userId?: string | null; apiKey?: string | null; provider?: string } = {}) {
  const apiKey = options.apiKey === undefined ? 'private-key' : options.apiKey
  await handle.db.insert(llmConnections).values({
    id,
    provider: options.provider ?? 'generic',
    name: id,
    userId: options.userId ?? null,
    config: JSON.stringify({ apiKeys: apiKey ? { genericApiKey: apiKey, genericBaseUrl: 'https://provider.example' } : {} }),
    modelOverrides: JSON.stringify([{ id: 'model', label: 'Model', supportedEfforts: ['low'] }]),
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run()
}

const setSettings = (change: (s: AppSettings) => void) => mutateSettings(change)

async function status(): Promise<{ apiKeyConfigured: boolean }> {
  const response = await app.request('/runtime-status')
  expect(response.status).toBe(200)
  return await response.json() as { apiKeyConfigured: boolean }
}

/** What the route answered before: the default resolved one row at a time. */
async function sequentialAnswer(): Promise<boolean> {
  const settings = await getSettings()
  const root = await resolveGlobalSelection(undefined, settings)
  return (root?.provider ?? activeLlmProviderFrom(settings)).apiKeyStatusFrom(settings).isConfigured
}

beforeEach(async () => {
  handle = await createTestDatabase()
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  await handle.db.insert(user).values({ id: 'alice', name: 'Alice', email: 'alice@example.com' }).run()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await handle.close()
})

/**
 * Each state of the app default the resolver distinguishes, with the number of
 * statements the route issued for it before (settings included).
 */
const states: Array<{ name: string; before: number; configured: boolean; arrange(): Promise<void> }> = [
  {
    name: 'the default is a shared connection',
    before: 2,
    configured: true,
    arrange: async () => {
      await connection('shared')
      await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    },
  },
  {
    name: 'the default is a shared connection whose model retired',
    before: 3,
    configured: true,
    arrange: async () => {
      await connection('shared')
      await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'retired-model' } })
    },
  },
  {
    name: 'the default is a shared connection without a key',
    before: 2,
    configured: false,
    arrange: async () => {
      await connection('shared', { apiKey: null })
      await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    },
  },
  {
    name: 'no default is saved and the migrated connection answers',
    before: 2,
    configured: true,
    arrange: async () => {
      await connection('migrated')
      await setSettings((s) => { s.llmLegacyProviderId = 'migrated' })
    },
  },
  {
    name: 'the default is a personal connection and the migrated one answers',
    before: 4,
    configured: true,
    arrange: async () => {
      await connection('personal', { userId: 'alice', apiKey: null })
      await connection('migrated')
      await setSettings((s) => {
        s.llmDefault = { llmProviderId: 'personal', model: 'model' }
        s.llmLegacyProviderId = 'migrated'
      })
    },
  },
  {
    name: 'the default and the migrated connection are gone and the provider\'s own answers',
    before: 5,
    configured: true,
    arrange: async () => {
      await connection('legacy-generic')
      await connection('other')
      await setSettings((s) => {
        s.llmDefault = { llmProviderId: 'deleted', model: 'model' }
        s.llmLegacyProviderId = 'also-deleted'
        s.llmProvider = 'generic'
      })
    },
  },
  {
    name: 'only a personal connection exists',
    before: 5,
    configured: false,
    arrange: async () => {
      await connection('personal', { userId: 'alice' })
      await setSettings((s) => {
        s.llmDefault = { llmProviderId: 'personal', model: 'model' }
        s.llmLegacyProviderId = 'deleted'
      })
    },
  },
  {
    name: 'nothing is set up',
    before: 2,
    configured: false,
    arrange: async () => {},
  },
]

describe('GET /api/runtime-status reads', () => {
  it.each(states)('two statements when $name', async ({ arrange, before, configured }) => {
    await arrange()
    const expected = await sequentialAnswer()
    expect(expected).toBe(configured)

    // The sequential resolver, as the route called it before.
    const earlier = countStatements()
    await sequentialAnswer()
    expect(earlier.count()).toBe(before)
    vi.restoreAllMocks()

    const statements = countStatements()
    expect((await status()).apiKeyConfigured).toBe(expected)
    expect(statements.count()).toBe(2)
    expect(statements.sql().filter(sql => sql.includes('llm_connections'))).toHaveLength(1)
  })

  it('reads the shared connections while the settings are still being read', async () => {
    await connection('shared')
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })

    let releaseSettings!: () => void
    const held = new Promise<void>((resolve) => { releaseSettings = resolve })
    const read = records.readStoredRecord
    const reads: MockInstance<typeof records.readStoredRecord> = vi.spyOn(records, 'readStoredRecord')
      .mockImplementation(async (...args) => {
        if (args[0] === SETTINGS_RECORD_KEY) await held
        return read(...args)
      })
    const statements = countStatements()

    const pending = app.request('/runtime-status')
    await vi.waitFor(() => expect(reads).toHaveBeenCalled())
    // The settings read has not answered, and the connections were asked for already.
    await vi.waitFor(() => expect(statements.sql().some(sql => sql.includes('llm_connections'))).toBe(true))

    releaseSettings()
    const response = await pending
    expect(await response.json()).toMatchObject({ apiKeyConfigured: true })
    expect(statements.count()).toBe(2)
  })

  it('does not bind an id per connection, however many are shared', async () => {
    for (let i = 0; i < 150; i++) await connection(`shared-${i}`)
    await connection('personal', { userId: 'alice' })
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared-149', model: 'model' } })

    const statements = countStatements()
    expect((await status()).apiKeyConfigured).toBe(true)
    expect(statements.count()).toBe(2)
    const [connections] = statements.sql().filter(sql => sql.includes('llm_connections'))
    expect(connections).not.toContain('?')
  })

  it('answers from what is saved now on every request', async () => {
    await connection('shared', { apiKey: null })
    await connection('keyed')
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    expect((await status()).apiKeyConfigured).toBe(false)

    await setSettings((s) => { s.llmDefault = { llmProviderId: 'keyed', model: 'model' } })
    expect((await status()).apiKeyConfigured).toBe(true)
  })

  it('fails the request when the connections cannot be read, as before', async () => {
    await connection('shared')
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    const target = session()
    const prepare = target.prepareQuery.bind(target)
    vi.spyOn(target, 'prepareQuery').mockImplementation((query, ...rest) => {
      if (query.sql.includes('llm_connections')) throw new Error('database is gone')
      return prepare(query, ...rest)
    })

    const response = await app.request('/runtime-status')
    expect(response.status).toBe(500)
  })
})
