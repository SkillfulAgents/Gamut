/**
 * The settings routes' changes are an admin's: in auth mode a member who is
 * not an admin is refused, an admin passes the gate (and then hears that this
 * deployment has no reach choice and no token, since `/mcp` is not served in
 * auth mode yet). The session is stood in for by a stub `Authenticated()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

const session = vi.hoisted(() => ({ user: { id: 'u1', role: 'user' as string } }))
vi.mock('../middleware/auth', async (original) => ({
  ...(await original<typeof import('../middleware/auth')>()),
  Authenticated: () => async (c: { set: (key: never, value: never) => void }, next: () => Promise<void>) => {
    c.set('user' as never, session.user as never)
    return next()
  },
}))

import routes from './mcp-server-settings'

const app = new Hono().route('/api/mcp-server', routes)

function put(path: string, body: unknown) {
  return app.request(`/api/mcp-server${path}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  handle = await createTestDatabase()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await handle.close()
})

describe('MCP server settings routes in auth mode', () => {
  it('refuse a member who is not an admin', async () => {
    session.user = { id: 'u1', role: 'user' }
    expect((await put('/reach', { reach: 'network' })).status).toBe(403)
    expect((await put('/enabled', { enabled: true })).status).toBe(403)
    expect((await app.request('/api/mcp-server/token/regenerate', { method: 'POST' })).status).toBe(403)
  })

  it('let an admin through the gate, where this deployment answers it has nothing to change yet', async () => {
    session.user = { id: 'a1', role: 'admin' }
    expect((await put('/reach', { reach: 'network' })).status).toBe(409)
    expect((await put('/enabled', { enabled: true })).status).toBe(409)
    const status = await (await app.request('/api/mcp-server')).json()
    expect(status).toMatchObject({ available: false, enabled: false, token: null, reach: { applies: false, value: 'this-computer', networkAddresses: [] } })
  })
})
