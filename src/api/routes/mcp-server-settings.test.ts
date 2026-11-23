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
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

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

describe('analytics events of the settings routes (desktop app, no auth mode)', () => {
  // The test setup mocks trackServerEvent for every test file.
  const track = vi.mocked(trackServerEvent)

  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'false')
    Object.defineProperty(process, 'type', { value: 'browser', configurable: true, writable: true })
    track.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, 'type', { value: undefined, configurable: true, writable: true })
  })

  it('mcp_server_toggled with enabled and auth_mode, only when the switch changed', async () => {
    expect((await put('/enabled', { enabled: true })).status).toBe(200) // already on by default
    expect(track).not.toHaveBeenCalled()
    expect((await put('/enabled', { enabled: false })).status).toBe(200)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenLastCalledWith('mcp_server_toggled', { enabled: false, auth_mode: false })
    await put('/enabled', { enabled: false })
    expect(track).toHaveBeenCalledTimes(1)
    await put('/enabled', { enabled: true })
    expect(track).toHaveBeenLastCalledWith('mcp_server_toggled', { enabled: true, auth_mode: false })
  })

  it('mcp_reach_changed with the reach, only when it changed', async () => {
    await put('/reach', { reach: 'this-computer' }) // the default
    expect(track).not.toHaveBeenCalled()
    await put('/reach', { reach: 'network' })
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenLastCalledWith('mcp_reach_changed', { reach: 'network' })
    await put('/reach', { reach: 'network' })
    expect(track).toHaveBeenCalledTimes(1)
  })

  it('mcp_token_regenerated with no properties, once per regenerate', async () => {
    expect((await app.request('/api/mcp-server/token/regenerate', { method: 'POST' })).status).toBe(200)
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenLastCalledWith('mcp_token_regenerated')
  })

  it('no event carries the token, an address or a person', async () => {
    const { token } = await (await app.request('/api/mcp-server/token/regenerate', { method: 'POST' })).json()
    await put('/enabled', { enabled: false })
    await put('/reach', { reach: 'network' })
    const sent = JSON.stringify(track.mock.calls)
    expect(sent).not.toContain(token)
    expect(sent).not.toMatch(/gamut_mcp_|https?:\/\/|\d+\.\d+\.\d+\.\d+|a1|u1/)
  })

  it('a refused change sends nothing', async () => {
    // Auth mode is a web deployment's (Electron ignores AUTH_MODE).
    Object.defineProperty(process, 'type', { value: undefined, configurable: true, writable: true })
    vi.stubEnv('AUTH_MODE', 'true')
    session.user = { id: 'u1', role: 'user' }
    await put('/enabled', { enabled: false })
    await put('/reach', { reach: 'network' })
    await app.request('/api/mcp-server/token/regenerate', { method: 'POST' })
    expect(track).not.toHaveBeenCalled()
  })
})
