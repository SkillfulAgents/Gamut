/**
 * The home graph and the activity statistics read several tables that do not
 * depend on one another. On a driver where a statement is a network round
 * trip (libsql over HTTP, Cloudflare D1) a read that waits for another one
 * adds a whole round trip, so these tests pin two things per function: how
 * many statements it sends, and that every one of them has been handed to the
 * driver before the first answer comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../db/schema'
import type { AppDatabase } from '../db/drivers/types'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase

vi.mock('../db', () => ({
  get db() { return testDb },
}))

const readMetadata = vi.fn(async () => ({}))
vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: { get: () => ({ sessions: { readMetadata } }) },
}))

import { buildHomeGraph } from './home-graph-service'
import { getAgentActivityStats, getConnectionActivityStats } from './activity-stats-service'

const NOW = new Date('2026-07-09T12:00:30.000Z')
const TODAY = new Date('2026-07-09T10:00:00.000Z')
/** Cloudflare D1 binds at most this many parameters per statement. */
const D1_MAX_BOUND_PARAMETERS = 100

type Terminator = 'all' | 'get' | 'values' | 'run'
type Prepared = Record<Terminator, (...args: unknown[]) => unknown>
interface DrizzleSession {
  prepareQuery(...args: unknown[]): Prepared
}

/**
 * Stands in for a driver whose statements take time: every statement sent
 * from here on is counted when it is handed to the driver, and none answers
 * until `release()`. `sql` lists the statements in the order they were sent,
 * `params` the values each one bound.
 */
function holdStatements() {
  const session = (testDb as unknown as { session: DrizzleSession }).session
  const prepare = session.prepareQuery.bind(session)
  const sent: { sql: string; params: unknown[] }[] = []
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })

  const spy = vi.spyOn(session, 'prepareQuery').mockImplementation((...args: unknown[]) => {
    const prepared = prepare(...args)
    const query = args[0] as { sql: string; params: unknown[] }
    // A driver's `all()` may call its own `values()`: only the caller's call is the statement.
    let handed = false
    for (const terminator of ['all', 'get', 'values', 'run'] as const) {
      const run = prepared[terminator].bind(prepared)
      prepared[terminator] = (...runArgs: unknown[]) => {
        if (handed) return run(...runArgs)
        handed = true
        sent.push({ sql: query.sql, params: query.params })
        return released.then(() => run(...runArgs))
      }
    }
    return prepared
  })

  return {
    sent,
    release,
    restore: () => spy.mockRestore(),
  }
}

/** Long enough for every continuation that does not wait for the driver to have run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

/**
 * Runs `work` against the held driver. `beforeFirstAnswer` is how many
 * statements had been sent while none had answered: equal to `total` exactly
 * when no read waits for another.
 */
async function wavesOf<T>(work: () => Promise<T>) {
  const held = holdStatements()
  try {
    const pending = work()
    await settle()
    const beforeFirstAnswer = held.sent.length
    held.release()
    const result = await pending
    return { result, beforeFirstAnswer, total: held.sent.length, sent: held.sent }
  } finally {
    held.release()
    held.restore()
  }
}

async function insertUser(id: string) {
  await testDb.insert(schema.user).values({
    id, name: id, email: `${id}@example.com`, emailVerified: false, createdAt: NOW, updatedAt: NOW,
  }).run()
}

async function insertAccounts(ids: string[], userId: string | null = null) {
  if (ids.length === 0) return
  await testDb.insert(schema.connectedAccounts).values(ids.map((id) => ({
    id, providerConnectionId: `pc-${id}`, toolkitSlug: 'github', displayName: id, userId, createdAt: NOW, updatedAt: NOW,
  }))).run()
}

async function insertMcps(ids: string[], userId: string | null = null) {
  if (ids.length === 0) return
  await testDb.insert(schema.remoteMcpServers).values(ids.map((id) => ({
    id, name: id, url: `https://${id}.example.com`, userId, createdAt: NOW, updatedAt: NOW,
  }))).run()
}

async function proxyCall(id: string, agentSlug: string, accountId: string, statusCode = 200, createdAt = TODAY) {
  await testDb.insert(schema.proxyAuditLog).values({
    id, agentSlug, accountId, toolkit: 'github', targetHost: 'api.github.com', targetPath: 'repos', method: 'GET', statusCode, createdAt,
  }).run()
}

async function mcpCall(id: string, agentSlug: string, remoteMcpId: string, statusCode = 200, createdAt = TODAY) {
  await testDb.insert(schema.mcpAuditLog).values({
    id, agentSlug, remoteMcpId, remoteMcpName: remoteMcpId, method: 'POST', requestPath: '/tools/call', statusCode, createdAt,
  }).run()
}

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  readMetadata.mockClear()
})

afterEach(async () => {
  await handle.close()
})

describe('home graph reads', () => {
  const scope = (agentSlugs: string[], userId: string | null = null) => ({
    agentSlugs,
    userId,
    isIntegrationConnected: (id: string) => id === 'chat2',
  })

  async function seedGraph() {
    await insertUser('u1')
    await insertAccounts(['accA'], 'u1')
    await insertMcps(['mcpX'], 'u1')
    await testDb.insert(schema.agentConnectedAccounts).values({ id: 'l1', agentSlug: 'agent1', connectedAccountId: 'accA', createdAt: NOW }).run()
    await testDb.insert(schema.agentRemoteMcps).values({ id: 'm1', agentSlug: 'agent2', remoteMcpId: 'mcpX', createdAt: NOW }).run()
    await testDb.insert(schema.chatIntegrations).values([
      { id: 'chat1', agentSlug: 'agent1', provider: 'telegram', config: '{}', status: 'error', createdAt: NOW, updatedAt: NOW },
      { id: 'chat2', agentSlug: 'agent2', provider: 'slack', name: 'Team', config: '{}', status: 'active', createdAt: NOW, updatedAt: NOW },
      { id: 'chat3', agentSlug: 'hidden', provider: 'telegram', config: '{}', status: 'active', createdAt: NOW, updatedAt: NOW },
    ]).run()
    await testDb.insert(schema.chatIntegrationSessions).values([
      { id: 's1', integrationId: 'chat2', externalChatId: 'x1', sessionId: 'sess1', createdAt: NOW, updatedAt: NOW },
      { id: 's2', integrationId: 'chat2', externalChatId: 'x2', sessionId: 'sess2', createdAt: NOW, updatedAt: NOW },
      { id: 's3', integrationId: 'chat3', externalChatId: 'x3', sessionId: 'sess3', createdAt: NOW, updatedAt: NOW },
    ]).run()
    await testDb.insert(schema.webhookTriggers).values({
      id: 'wh1', agentSlug: 'agent1', triggerType: 'GMAIL_NEW_EMAIL', prompt: 'p', status: 'active', fireCount: 5, createdAt: NOW,
    }).run()
    await testDb.insert(schema.scheduledTasks).values({
      id: 'cr1', agentSlug: 'agent2', scheduleType: 'cron', scheduleExpression: '0 9 * * *', prompt: 'p', status: 'pending', nextExecutionAt: NOW, isRecurring: true, executionCount: 3, createdAt: NOW,
    }).run()
    await testDb.insert(schema.xAgentPolicies).values({
      id: 'p1', callerAgentSlug: 'agent1', targetAgentSlug: 'agent2', operation: 'invoke', decision: 'allow', createdAt: NOW, updatedAt: NOW,
    }).run()
    await proxyCall('pa1', 'agent1', 'accA')
    await mcpCall('ma1', 'agent2', 'mcpX')
  }

  it.each([
    ['local mode', null],
    ['auth mode', 'u1'],
  ])('sends its nine statements before the first one answers (%s)', async (_name, userId) => {
    await seedGraph()

    const { result, beforeFirstAnswer, total } = await wavesOf(() => buildHomeGraph(scope(['agent1', 'agent2'], userId)))

    expect(total).toBe(9)
    expect(beforeFirstAnswer).toBe(9)
    // The two reads that used to wait their turn still land in the payload.
    expect(result.chats).toEqual(expect.arrayContaining([
      { id: 'chat1', agentSlug: 'agent1', provider: 'telegram', name: null, status: 'error', connected: false, sessionCount: 0 },
      { id: 'chat2', agentSlug: 'agent2', provider: 'slack', name: 'Team', status: 'active', connected: true, sessionCount: 2 },
    ]))
    expect(result.chats).toHaveLength(2)
    expect(result.accountLinks).toEqual([{ agentSlug: 'agent1', accountId: 'accA' }])
    expect(result.mcpLinks).toEqual([{ agentSlug: 'agent2', mcpId: 'mcpX' }])
    expect(result.webhooks.map((w) => w.id)).toEqual(['wh1'])
    expect(result.crons.map((c) => c.id)).toEqual(['cr1'])
    expect(result.permissions).toEqual([{ caller: 'agent1', target: 'agent2' }])
    expect(result.accountUsage).toEqual({ 'agent1:accA': 1 })
    expect(result.mcpUsage).toEqual({ 'agent2:mcpX': 1 })
  })

  it('sends the same nine statements when the visible agents have nothing', async () => {
    const { result, beforeFirstAnswer, total } = await wavesOf(() => buildHomeGraph(scope(['lonely'])))

    expect({ beforeFirstAnswer, total }).toEqual({ beforeFirstAnswer: 9, total: 9 })
    expect(result).toEqual({
      accountLinks: [], mcpLinks: [], chats: [], webhooks: [], crons: [], permissions: [], invocations: [], accountUsage: {}, mcpUsage: {},
    })
  })

  it('sends nothing for an empty scope', async () => {
    await seedGraph()

    const { result, total } = await wavesOf(() => buildHomeGraph(scope([])))

    expect(total).toBe(0)
    expect(result.chats).toEqual([])
  })

  it('fails as a whole when a required read fails, with no rejection left unhandled', async () => {
    await seedGraph()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const session = (testDb as unknown as { session: DrizzleSession }).session
    const prepare = session.prepareQuery.bind(session)
    // Both chat reads fail: the second failure must not escape the first one's rejection.
    const spy = vi.spyOn(session, 'prepareQuery').mockImplementation((...args: unknown[]) => {
      const query = args[0] as { sql: string }
      if (query.sql.includes('from "chat_integration')) throw new Error('chat tables unavailable')
      return prepare(...args)
    })
    try {
      await expect(buildHomeGraph(scope(['agent1', 'agent2']))).rejects.toThrow('chat tables unavailable')
      await settle()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
      process.off('unhandledRejection', unhandled)
    }
  })

  it('still degrades a failed usage count to no weights', async () => {
    await seedGraph()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = (testDb as unknown as { session: DrizzleSession }).session
    const prepare = session.prepareQuery.bind(session)
    const spy = vi.spyOn(session, 'prepareQuery').mockImplementation((...args: unknown[]) => {
      const query = args[0] as { sql: string }
      if (query.sql.includes('from "proxy_audit_log"')) throw new Error('audit unavailable')
      return prepare(...args)
    })
    try {
      const result = await buildHomeGraph(scope(['agent1', 'agent2']))
      expect(result.accountUsage).toEqual({})
      expect(result.mcpUsage).toEqual({ 'agent2:mcpX': 1 })
      expect(result.chats).toHaveLength(2)
    } finally {
      spy.mockRestore()
      errors.mockRestore()
    }
  })
})

describe('agent activity reads', () => {
  it.each([
    ['local mode', undefined],
    ['auth mode', 'owner-a'],
  ])('sends its six statements before the first one answers (%s)', async (_name, ownerId) => {
    await insertUser('owner-a')
    await insertAccounts(['account-a'], 'owner-a')
    await insertMcps(['mcp-a'], 'owner-a')
    await testDb.insert(schema.agentConnectedAccounts).values({ id: 'l1', agentSlug: 'agent-a', connectedAccountId: 'account-a', createdAt: NOW }).run()
    await testDb.insert(schema.agentRemoteMcps).values({ id: 'm1', agentSlug: 'agent-a', remoteMcpId: 'mcp-a', createdAt: NOW }).run()
    await proxyCall('p1', 'agent-a', 'account-a')
    await mcpCall('m1', 'agent-a', 'mcp-a', 500)

    const { result, beforeFirstAnswer, total } = await wavesOf(() => getAgentActivityStats('agent-a', { days: 2, now: NOW, ownerId }))

    expect(total).toBe(6)
    expect(beforeFirstAnswer).toBe(6)
    expect(readMetadata).toHaveBeenCalledTimes(1)
    expect(result.connectionById['account-account-a']![1]).toEqual({ date: '2026-07-09', succeeded: 1, failed: 0 })
    expect(result.connectionById['mcp-mcp-a']![1]).toEqual({ date: '2026-07-09', succeeded: 0, failed: 1 })
  })
})

describe('connection activity reads', () => {
  const zeroes = [
    { date: '2026-07-08', succeeded: 0, failed: 0 },
    { date: '2026-07-09', succeeded: 0, failed: 0 },
  ]

  it.each([
    ['local mode', undefined],
    ['auth mode', 'owner-a'],
  ])('sends its four statements before the first one answers (%s)', async (_name, ownerId) => {
    await insertUser('owner-a')
    await insertUser('owner-b')
    await insertAccounts(['account-a', 'account-quiet'], 'owner-a')
    await insertAccounts(['account-b'], 'owner-b')
    await insertMcps(['mcp-a'], 'owner-a')
    await insertMcps(['mcp-b'], 'owner-b')
    await proxyCall('p1', 'agent-a', 'account-a')
    await proxyCall('p2', 'agent-a', 'account-a', 500)
    await proxyCall('p3', 'agent-b', 'account-b')
    await mcpCall('m1', 'agent-a', 'mcp-a', 500)
    await mcpCall('m2', 'agent-b', 'mcp-b')

    const { result, beforeFirstAnswer, total } = await wavesOf(() => getConnectionActivityStats({ days: 2, now: NOW, ownerId }))

    expect(total).toBe(4)
    expect(beforeFirstAnswer).toBe(4)
    const mine = {
      'account-account-a': [zeroes[0], { date: '2026-07-09', succeeded: 1, failed: 1 }],
      'account-account-quiet': zeroes,
      'mcp-mcp-a': [zeroes[0], { date: '2026-07-09', succeeded: 0, failed: 1 }],
    }
    const theirs = {
      'account-account-b': [zeroes[0], { date: '2026-07-09', succeeded: 1, failed: 0 }],
      'mcp-mcp-b': [zeroes[0], { date: '2026-07-09', succeeded: 1, failed: 0 }],
    }
    expect(result.connectionById).toEqual(ownerId ? mine : { ...mine, ...theirs })
  })

  it('answers nothing when there are no connections, whatever the audit log holds', async () => {
    // A deleted connection leaves its audit rows behind.
    await proxyCall('p1', 'agent-a', 'account-gone')
    await mcpCall('m1', 'agent-a', 'mcp-gone')

    const result = await getConnectionActivityStats({ days: 2, now: NOW })

    expect(result.connectionById).toEqual({})
  })

  it("leaves out calls older than the window and another owner's calls on a shared id space", async () => {
    await insertUser('owner-a')
    await insertAccounts(['account-a'], 'owner-a')
    await insertAccounts(['account-local'])
    await proxyCall('old', 'agent-a', 'account-a', 200, new Date('2026-07-01T10:00:00.000Z'))
    await proxyCall('new', 'agent-a', 'account-a', 200)
    await proxyCall('local', 'agent-a', 'account-local', 200)

    const result = await getConnectionActivityStats({ days: 2, now: NOW, ownerId: 'owner-a' })

    expect(result.connectionById).toEqual({
      'account-account-a': [zeroes[0], { date: '2026-07-09', succeeded: 1, failed: 0 }],
    })
  })

  // The rollups used to bind one parameter per connection id.
  it.each([1, 150, 1200])('binds the same few parameters for %i connections', async (count) => {
    const accounts = Array.from({ length: count }, (_, i) => `account-${i}`)
    const mcps = Array.from({ length: count }, (_, i) => `mcp-${i}`)
    for (let i = 0; i < count; i += 100) {
      await insertAccounts(accounts.slice(i, i + 100))
      await insertMcps(mcps.slice(i, i + 100))
    }
    await proxyCall('first', 'agent-a', accounts[0]!)
    await proxyCall('last', 'agent-a', accounts[count - 1]!, 500)
    await mcpCall('m-last', 'agent-a', mcps[count - 1]!)

    const { result, total, sent } = await wavesOf(() => getConnectionActivityStats({ days: 2, now: NOW }))

    expect(total).toBe(4)
    const bound = sent.map((statement) => statement.params.length)
    expect(Math.max(...bound)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
    expect(Math.max(...bound)).toBeLessThan(20)
    expect(Object.keys(result.connectionById)).toHaveLength(count * 2)
    const today = (id: string) => result.connectionById[id]![1]
    expect(today(`account-${accounts[count - 1]}`)).toEqual({ date: '2026-07-09', succeeded: count === 1 ? 1 : 0, failed: 1 })
    expect(today(`mcp-${mcps[count - 1]}`)).toEqual({ date: '2026-07-09', succeeded: 1, failed: 0 })
    if (count > 1) {
      expect(today(`account-${accounts[0]}`)).toEqual({ date: '2026-07-09', succeeded: 1, failed: 0 })
      expect(result.connectionById[`account-${accounts[1]}`]).toEqual(zeroes)
    }
  })
})
