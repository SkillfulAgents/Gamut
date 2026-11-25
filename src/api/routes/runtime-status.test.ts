// @libsql-must-pass
/**
 * GET /api/runtime-status is polled by every open window, so what it reads is
 * pinned here for each state of the app default.
 *
 * The usual state (a saved default that is a shared connection) costs what it
 * always did: the settings, then that one row by id. What changed is the rest:
 * the default's row is read once, not again for the fallback within it, and
 * the other candidates (two at most) are read in one statement, not one each.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import { getSettings, mutateSettings, type AppSettings } from '@shared/lib/config/settings'
import { llmConnections, user } from '@shared/lib/db/schema'
import { resolveGlobalSelection, type ConnectionRow } from '@shared/lib/llm-provider/connections'
import runtimeStatusRoutes from './runtime-status'

const app = new Hono().route('/runtime-status', runtimeStatusRoutes)

type Statement = { sql: string; params: unknown[] }
type Session = { prepareQuery(query: Statement, ...rest: unknown[]): unknown }
const session = () => (handle.db as unknown as { session: Session }).session

/** Statements sent to the driver from here on: every one is prepared by the drizzle session. */
function countStatements(): { count(): number; connections(): Statement[] } {
  const prepare = vi.spyOn(session(), 'prepareQuery')
  return {
    count: () => prepare.mock.calls.length,
    connections: () => prepare.mock.calls.map(([query]) => query).filter(({ sql }) => sql.includes('llm_connections')),
  }
}

async function connection(id: string, options: { userId?: string | null; apiKey?: string | null; provider?: string } = {}): Promise<ConnectionRow> {
  const apiKey = options.apiKey === undefined ? 'private-key' : options.apiKey
  const [row] = await handle.db.insert(llmConnections).values({
    id,
    provider: options.provider ?? 'generic',
    name: id,
    userId: options.userId ?? null,
    config: JSON.stringify({ apiKeys: apiKey ? { genericApiKey: apiKey, genericBaseUrl: 'https://provider.example' } : {} }),
    modelOverrides: JSON.stringify([{ id: 'model', label: 'Model', supportedEfforts: ['low'] }]),
    createdAt: new Date(),
    updatedAt: new Date(),
  }).returning()
  return row
}

const setSettings = (change: (s: AppSettings) => void) => mutateSettings(change)

async function status(): Promise<{ apiKeyConfigured: boolean }> {
  const response = await app.request('/runtime-status')
  expect(response.status).toBe(200)
  return await response.json() as { apiKeyConfigured: boolean }
}

beforeEach(async () => {
  handle = await createTestDatabase()
  // With no shared connection to answer, the route asks the ambient Anthropic
  // provider, which reads both of these from the environment.
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
  await handle.db.insert(user).values({ id: 'alice', name: 'Alice', email: 'alice@example.com' }).run()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await handle.close()
})

interface State {
  name: string
  /** Statements the route issues, the settings read included. */
  statements: number
  /** What it issued before the candidates were read together. */
  before: number
  /** Ids bound by the one statement that reads the remaining candidates; none when it is not needed. */
  together: string[] | null
  configured: boolean
  /** The connection the default resolves to. */
  resolved: string | null
  arrange(): Promise<void>
}

const states: State[] = [
  {
    name: 'the default is a shared connection',
    statements: 2, before: 2, together: null, configured: true, resolved: 'shared',
    arrange: async () => {
      await connection('shared')
      await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    },
  },
  {
    name: 'the default is a shared connection and every other candidate exists',
    statements: 2, before: 2, together: null, configured: true, resolved: 'shared',
    arrange: async () => {
      await connection('shared')
      await connection('migrated', { apiKey: null })
      await connection('legacy-anthropic', { apiKey: null })
      await setSettings((s) => {
        s.llmDefault = { llmProviderId: 'shared', model: 'model' }
        s.llmLegacyProviderId = 'migrated'
      })
    },
  },
  {
    name: 'the default is a shared connection without a key',
    statements: 2, before: 2, together: null, configured: false, resolved: 'shared',
    arrange: async () => {
      await connection('shared', { apiKey: null })
      await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    },
  },
  {
    name: 'the default is a shared connection whose model retired',
    statements: 2, before: 3, together: null, configured: true, resolved: 'shared',
    arrange: async () => {
      await connection('shared')
      await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'retired-model' } })
    },
  },
  {
    name: 'no default is saved and the migrated connection answers',
    statements: 2, before: 2, together: ['migrated', 'legacy-anthropic'], configured: true, resolved: 'migrated',
    arrange: async () => {
      await connection('migrated')
      await connection('legacy-anthropic', { apiKey: null })
      await setSettings((s) => { s.llmLegacyProviderId = 'migrated' })
    },
  },
  {
    name: 'the default is a personal connection and the migrated one answers',
    statements: 3, before: 4, together: ['migrated', 'legacy-anthropic'], configured: true, resolved: 'migrated',
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
    statements: 3, before: 5, together: ['also-deleted', 'legacy-generic'], configured: true, resolved: 'legacy-generic',
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
    name: 'the migrated connection is personal and the provider\'s own answers',
    statements: 2, before: 3, together: ['personal', 'legacy-anthropic'], configured: true, resolved: 'legacy-anthropic',
    arrange: async () => {
      await connection('personal', { userId: 'alice' })
      await connection('legacy-anthropic')
      await setSettings((s) => { s.llmLegacyProviderId = 'personal' })
    },
  },
  {
    name: 'only a personal connection exists',
    statements: 3, before: 5, together: ['deleted', 'legacy-anthropic'], configured: false, resolved: null,
    arrange: async () => {
      await connection('personal', { userId: 'alice' })
      await setSettings((s) => {
        s.llmDefault = { llmProviderId: 'personal', model: 'model' }
        s.llmLegacyProviderId = 'deleted'
      })
    },
  },
  {
    name: 'the migrated connection is the provider\'s own',
    statements: 2, before: 2, together: ['legacy-anthropic'], configured: false, resolved: null,
    arrange: async () => {
      await setSettings((s) => { s.llmLegacyProviderId = 'legacy-anthropic' })
    },
  },
  {
    name: 'nothing is set up',
    statements: 2, before: 2, together: ['legacy-anthropic'], configured: false, resolved: null,
    arrange: async () => {},
  },
]

describe('GET /api/runtime-status reads', () => {
  it.each(states)('$statements statements when $name', async ({ arrange, statements, before, together, configured, resolved }) => {
    await arrange()
    expect((await resolveGlobalSelection(undefined, await getSettings()))?.llmProviderId ?? null).toBe(resolved)

    const issued = countStatements()
    expect((await status()).apiKeyConfigured).toBe(configured)

    expect(issued.count()).toBe(statements)
    // Never more than it issued before.
    expect(statements).toBeLessThanOrEqual(before)
    // The saved default is read alone, by id: one row at most. Whatever else is
    // read is one statement over the candidates not read yet.
    const lists = issued.connections().filter(({ sql }) => / in \(/.test(sql))
    const single = issued.connections().filter(({ sql }) => !/ in \(/.test(sql))
    expect(single.length).toBeLessThanOrEqual(1)
    expect(lists.map(({ params }) => params)).toEqual(together ? [together] : [])
    expect(issued.count()).toBe(1 + single.length + lists.length)
  })

  it('binds two ids at most, whatever the settings name', async () => {
    for (const { arrange } of states) {
      await handle.db.delete(llmConnections).run()
      await setSettings((s) => { delete s.llmDefault; delete s.llmLegacyProviderId; delete s.llmProvider })
      await arrange()
      const issued = countStatements()
      await status()
      for (const { params } of issued.connections()) expect(params.length).toBeLessThanOrEqual(2)
      vi.restoreAllMocks()
    }
  })

  it('reads one connection row however many are shared', async () => {
    for (let i = 0; i < 150; i++) await connection(`shared-${i}`)
    await connection('personal', { userId: 'alice' })
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared-149', model: 'model' } })

    const issued = countStatements()
    expect((await status()).apiKeyConfigured).toBe(true)
    expect(issued.count()).toBe(2)
    const [read] = issued.connections()
    expect(read.sql).toMatch(/where "llm_connections"\."id" = \?/)
    expect(read.params.slice(0, 1)).toEqual(['shared-149'])
  })

  it('answers from what is saved now on every request', async () => {
    await connection('shared', { apiKey: null })
    await connection('keyed')
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'model' } })
    expect((await status()).apiKeyConfigured).toBe(false)

    await setSettings((s) => { s.llmDefault = { llmProviderId: 'keyed', model: 'model' } })
    expect((await status()).apiKeyConfigured).toBe(true)
  })

  it('fails the request when the candidates cannot be read', async () => {
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'deleted', model: 'model' } })
    const target = session()
    const prepare = target.prepareQuery.bind(target)
    vi.spyOn(target, 'prepareQuery').mockImplementation((query, ...rest) => {
      if (/ in \(/.test(query.sql)) throw new Error('database is gone')
      return prepare(query, ...rest)
    })

    const response = await app.request('/runtime-status')
    expect(response.status).toBe(500)
  })
})

describe('resolveGlobalSelection with rows already read', () => {
  it('reads nothing when the default is among them', async () => {
    const shared = await connection('shared')
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'shared', model: 'retired-model' } })
    const settings = await getSettings()

    const issued = countStatements()
    const root = await resolveGlobalSelection(new Map([[shared.id, shared]]), settings)
    expect(root?.llmProviderId).toBe('shared')
    expect(issued.count()).toBe(0)
  })

  it('reads only the candidates that are not among them, together', async () => {
    const personal = await connection('personal', { userId: 'alice' })
    await connection('migrated')
    await setSettings((s) => {
      s.llmDefault = { llmProviderId: 'personal', model: 'model' }
      s.llmLegacyProviderId = 'migrated'
    })
    const settings = await getSettings()

    const issued = countStatements()
    const root = await resolveGlobalSelection(new Map([[personal.id, personal]]), settings)
    expect(root?.llmProviderId).toBe('migrated')
    expect(issued.count()).toBe(1)
    expect(issued.connections()[0].params).toEqual(['migrated', 'legacy-anthropic'])
  })

  it('does not change the map it was given', async () => {
    const personal = await connection('personal', { userId: 'alice' })
    await setSettings((s) => { s.llmDefault = { llmProviderId: 'personal', model: 'model' } })
    const read = new Map([[personal.id, personal]])

    await resolveGlobalSelection(read, await getSettings())
    expect([...read.keys()]).toEqual(['personal'])
  })
})
