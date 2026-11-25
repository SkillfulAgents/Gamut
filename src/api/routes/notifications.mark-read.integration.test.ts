/**
 * POST /api/notifications/:id/read against a real database and the real
 * middlewares: how many statements one click costs, and that who is let in,
 * what is marked and whose agent state comes back are what three reads of the
 * row decided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
let testDb: AppDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

let authMode = true
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => authMode }))

// The session is whoever the `x-test-user` header names: this file is about what follows it.
const users: Record<string, { id: string; role?: string }> = {
  member: { id: 'member' },
  peer: { id: 'peer' },
  outsider: { id: 'outsider' },
  admin: { id: 'admin', role: 'admin' },
  'member-admin': { id: 'member-admin', role: 'admin' },
}
vi.mock('@shared/lib/auth/index', () => ({
  getAuth: () => ({
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const user = users[headers.get('x-test-user') ?? '']
        return { response: user ? { user, session: { id: `session-${user.id}`, userId: user.id } } : null, headers: new Headers() }
      },
    },
  }),
}))
vi.mock('@shared/lib/meeting-integrations/participant-credential', () => ({
  authenticateMeetingParticipant: async (cookie: string | undefined) =>
    cookie === 'participant' ? { userId: 'member', agentSlug: 'shared', sessionId: 's1' } : null,
  meetingParticipantMayRequest: () => true,
}))
vi.mock('@shared/lib/agent-actor', () => ({ agentRegistry: { get: () => ({
  live: async () => ({ awaitingSessionIds: [], pendingReviews: [] }),
  sessions: { summary: async () => ({ sessionIds: ['s1', 's2'], sessionCount: 2, lastActivityAt: null, metadata: {} }) },
}) } }))

import notificationsRouter from './notifications'
import { createNotification, getNotification } from '@shared/lib/services/notification-service'
import { notificationReadAgentSlugs, notificationReadState } from '@shared/lib/services/notification-read-state'
import { notificationReadResponseSchema } from '@shared/lib/notifications/read-state-schema'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import { NOTIFICATION_CLIENT_HEADER } from '@shared/lib/notifications/notification-change-schema'

const app = new Hono().route('/api/notifications', notificationsRouter)

function send(method: 'POST' | 'DELETE', path: string, user: string | null, headers: Record<string, string> = {}) {
  return app.request(`/api/notifications/${path}`, { method, headers: { ...(user ? { 'x-test-user': user } : {}), ...headers } })
}
const markRead = (id: string, user: string | null, headers?: Record<string, string>) => send('POST', `${id}/read`, user, headers)

async function create(options: Partial<Parameters<typeof createNotification>[0]> = {}) {
  return createNotification({ title: 'Done', body: 'Done', type: 'session_complete', sessionId: 's1', agentSlug: 'shared', ...options })
}
const isRead = async (id: string) => (await getNotification(id))?.isRead

/** Every statement the driver is asked to run, in order, as its SQL text. */
function recordStatements(): string[] {
  const statements: string[] = []
  const session = (testDb as unknown as { session: { prepareQuery(query: { sql: string }, ...rest: unknown[]): unknown } }).session
  const prepare = session.prepareQuery.bind(session)
  vi.spyOn(session, 'prepareQuery').mockImplementation((query, ...rest) => {
    statements.push(query.sql)
    return prepare(query, ...rest)
  })
  return statements
}
const beforeTheUpdate = (statements: string[]) => statements.findIndex(sql => /^update/i.test(sql))

beforeEach(async () => {
  authMode = true
  handle = await createTestDatabase()
  testDb = handle.db
  await testDb.insert(schema.user).values(Object.values(users).map(({ id }) => ({ id, name: id, email: `${id}@example.test` }))).run()
  await testDb.insert(schema.agentAcl).values([
    { id: 'acl-1', userId: 'member', agentSlug: 'shared', role: 'user', createdAt: new Date(0) },
    { id: 'acl-2', userId: 'peer', agentSlug: 'shared', role: 'viewer', createdAt: new Date(0) },
    { id: 'acl-3', userId: 'peer', agentSlug: 'private', role: 'owner', createdAt: new Date(0) },
    { id: 'acl-4', userId: 'outsider', agentSlug: 'elsewhere', role: 'owner', createdAt: new Date(0) },
    { id: 'acl-5', userId: 'member-admin', agentSlug: 'shared', role: 'owner', createdAt: new Date(0) },
  ]).run()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await handle.close()
})

describe('what one mark-read costs', () => {
  it('a member: one statement before the UPDATE, seven in all', async () => {
    const id = await create()
    await create({ sessionId: 's2' })
    const statements = recordStatements()

    const response = await markRead(id, 'member')

    expect(response.status).toBe(200)
    // The row with the viewer's role, then the write.
    expect(beforeTheUpdate(statements)).toBe(1)
    expect(statements[0]).toMatch(/from "notifications" left join "agent_acl"/i)
    // Then the confirmation's five reads (counts, unread, mentions, marks, previews).
    expect(statements).toHaveLength(7)
    expect(statements.filter(sql => /^update/i.test(sql))).toHaveLength(1)
  })

  it('an admin: the same single statement before the UPDATE', async () => {
    const [first, second] = [await create(), await create()]
    const statements = recordStatements()

    expect((await markRead(first, 'member-admin')).status).toBe(200)
    expect(beforeTheUpdate(statements)).toBe(1)
    expect(statements).toHaveLength(7)

    // Without the agent there is no agent state to read: only the counts follow the write.
    statements.length = 0
    expect((await markRead(second, 'admin')).status).toBe(200)
    expect(beforeTheUpdate(statements)).toBe(1)
    expect(statements).toHaveLength(3)
  })

  it('without auth mode: the UPDATE comes first, five in all', async () => {
    authMode = false
    const id = await create()
    const statements = recordStatements()

    expect((await markRead(id, null)).status).toBe(200)

    expect(beforeTheUpdate(statements)).toBe(0)
    // No viewer, so no mentions read.
    expect(statements).toHaveLength(5)
  })

  it('a refusal is decided in one statement and writes nothing', async () => {
    const id = await create()
    const mention = await create({ type: 'session_mention', recipientUserId: 'peer' })
    const statements = recordStatements()

    expect((await markRead(id, 'outsider')).status).toBe(403)
    expect((await markRead(mention, 'member')).status).toBe(404)
    expect((await markRead('missing', 'member')).status).toBe(404)

    expect(statements).toHaveLength(3)
    expect(statements.some(sql => /^update/i.test(sql))).toBe(false)
  })

  it('nothing is read without a session', async () => {
    const id = await create()
    const statements = recordStatements()

    expect((await markRead(id, null)).status).toBe(401)

    expect(statements).toHaveLength(0)
    expect(await isRead(id)).toBe(false)
  })
})

describe('who may mark a notification read', () => {
  it.each([
    ['member', 'shared', 200], ['peer', 'shared', 200], ['outsider', 'shared', 403],
    ['admin', 'shared', 200], ['member-admin', 'shared', 200],
    ['member', 'private', 403], ['peer', 'private', 200], ['admin', 'private', 200],
  ] as const)('%s on a notification of %s is %i', async (user, agentSlug, status) => {
    const id = await create({ agentSlug })
    expect((await markRead(id, user)).status).toBe(status)
    expect(await isRead(id)).toBe(status === 200)
  })

  it("keeps a mention its recipient's alone, admins included", async () => {
    const mention = await create({ type: 'session_mention', recipientUserId: 'member' })
    for (const user of ['peer', 'admin', 'member-admin', 'outsider']) {
      expect((await markRead(mention, user)).status).toBe(404)
    }
    expect(await isRead(mention)).toBe(false)
    expect((await markRead(mention, 'member')).status).toBe(200)
    expect(await isRead(mention)).toBe(true)
  })

  it('refuses a mention whose recipient lost the agent', async () => {
    const mention = await create({ agentSlug: 'private', type: 'session_mention', recipientUserId: 'member' })
    expect((await markRead(mention, 'member')).status).toBe(403)
    expect(await isRead(mention)).toBe(false)
  })

  it('answers 404 for a notification that does not exist, whoever asks', async () => {
    for (const user of ['member', 'outsider', 'admin']) {
      expect((await markRead('missing', user)).status).toBe(404)
    }
    authMode = false
    expect((await markRead('missing', null)).status).toBe(404)
  })

  it('refuses a meeting participant', async () => {
    const id = await create()
    expect((await markRead(id, null, { cookie: 'participant' })).status).toBe(403)
    expect(await isRead(id)).toBe(false)
  })

  it('marks an already-read notification again without failing', async () => {
    const id = await create()
    expect((await markRead(id, 'member')).status).toBe(200)
    expect((await markRead(id, 'member')).status).toBe(200)
  })

  it('guards DELETE the same way', async () => {
    const id = await create()
    expect((await send('DELETE', id, 'outsider')).status).toBe(403)
    expect(await getNotification(id)).not.toBeNull()
    expect((await send('DELETE', id, 'member')).status).toBe(204)
    expect(await getNotification(id)).toBeNull()
    expect((await send('DELETE', id, 'member')).status).toBe(404)
  })
})

describe('the read state sent back', () => {
  // What the handler used to derive with its own read of the row.
  async function expected(id: string, viewerId: string | undefined) {
    return notificationReadState(await notificationReadAgentSlugs({ kind: 'notification', id }, viewerId), viewerId)
  }
  async function readStateOf(id: string, user: string | null) {
    const response = await markRead(id, user)
    expect(response.status).toBe(200)
    return notificationReadResponseSchema.parse(await response.json()).readState
  }

  it.each(['member', 'peer', 'member-admin'])('is the agent\'s state for %s, who holds the agent', async (user) => {
    const id = await create()
    const next = await create({ sessionId: 's2', body: 'Next' })
    await create({ agentSlug: 'private' })

    const readState = await readStateOf(id, user)

    expect(readState).toEqual(await expected(id, user))
    // Only the notification's agent, though peer also holds `private`.
    expect(readState).toMatchObject({ count: user === 'peer' ? 2 : 1, agents: [{
      slug: 'shared', hasUnreadNotifications: true, unreadSessionIds: ['s2'],
      notificationPreview: 'Next', notificationPreviewSource: { id: next, sessionId: 's2' },
    }] })
    expect(readState?.agents).toHaveLength(1)
  })

  it('names no agent to an admin who does not hold it', async () => {
    const id = await create()
    await create({ sessionId: 's2' })

    const readState = await readStateOf(id, 'admin')

    expect(readState).toEqual(await expected(id, 'admin'))
    expect(readState).toMatchObject({ count: 0, agents: [] })
    expect(await isRead(id)).toBe(true)
  })

  it("is the recipient's own for a mention", async () => {
    const mention = await create({ type: 'session_mention', recipientUserId: 'member' })
    await create({ type: 'session_mention', recipientUserId: 'member', sessionId: 's2' })
    await create({ type: 'session_mention', recipientUserId: 'peer', sessionId: 's2' })

    const readState = await readStateOf(mention, 'member')

    expect(readState).toEqual(await expected(mention, 'member'))
    expect(readState).toMatchObject({ mentions: 1, agents: [{ slug: 'shared', hasUnreadMention: true, mentionedSessionIds: ['s2'] }] })
  })

  it('is the agent\'s state without auth mode', async () => {
    authMode = false
    const id = await create({ agentSlug: 'private' })
    await create({ agentSlug: 'private', sessionId: 's2' })

    const readState = await readStateOf(id, null)

    expect(readState).toEqual(await expected(id, undefined))
    expect(readState).toMatchObject({ count: 1, agents: [{ slug: 'private', unreadSessionIds: ['s2'] }] })
  })

  it('tells the other clients once, naming the one that wrote', async () => {
    const id = await create()
    const publish = vi.spyOn(globalFeed, 'publish')
    const sourceClientId = crypto.randomUUID()

    expect((await markRead(id, 'member', { [NOTIFICATION_CLIENT_HEADER]: sourceClientId })).status).toBe(200)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith({ type: 'notifications_changed', agentSlug: 'shared', sourceClientId })
  })
})
