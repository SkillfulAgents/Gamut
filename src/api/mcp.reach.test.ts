/**
 * Who can reach `/mcp` in the desktop app (`process.type === 'browser'`, where
 * Electron main hosts the API on 0.0.0.0), through the real app: the request's
 * socket source decides, before the token is looked at. The socket is given as
 * @hono/node-server gives it (`env.incoming.socket`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

import app from './index'
import { getOrCreateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { setMcpServerEnabled, setMcpServerReach } from '@shared/lib/mcp-server/mcp-server-settings'

const LAN = '192.168.0.42'

function socket(remoteAddress: string) {
  return { incoming: { socket: { remoteAddress, remotePort: 51515, remoteFamily: remoteAddress.includes(':') ? 'IPv6' : 'IPv4' } } }
}

async function listTools(from: string, token: string | null, headers: Record<string, string> = {}) {
  return app.request('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }, socket(from))
}

function setProcessType(value: string | undefined) {
  Object.defineProperty(process, 'type', { value, configurable: true, writable: true })
}

beforeEach(async () => {
  handle = await createTestDatabase()
  setProcessType('browser')
})

afterEach(async () => {
  setProcessType(undefined)
  await backgroundSettled()
  await handle.close()
})

describe('/mcp reach in the desktop app', () => {
  it('admits this computer by default: IPv4, IPv6 and IPv4-mapped loopback', async () => {
    const token = await getOrCreateMcpInstallationToken()
    for (const from of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect((await listTools(from, token)).status, from).toBe(200)
    }
  })

  it('refuses another device by default with 403 and no Bearer challenge, before the token is looked at', async () => {
    const token = await getOrCreateMcpInstallationToken()
    for (const sent of [token, 'gamut_mcp_wrong', null]) {
      const response = await listTools(LAN, sent)
      expect(response.status).toBe(403)
      expect(response.headers.get('www-authenticate')).toBeNull()
      expect((await response.json()).error).toMatch(/this computer only/)
    }
  })

  it('never takes the source from X-Forwarded-For or Forwarded', async () => {
    const token = await getOrCreateMcpInstallationToken()
    const response = await listTools(LAN, token, { 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1', 'X-Real-IP': '127.0.0.1' })
    expect(response.status).toBe(403)
  })

  it('admits other devices once reach is network, on the next request; the token still decides', async () => {
    const token = await getOrCreateMcpInstallationToken()
    expect((await listTools(LAN, token)).status).toBe(403)
    await setMcpServerReach('network')
    expect((await listTools(LAN, token)).status).toBe(200)
    expect((await listTools(LAN, 'gamut_mcp_wrong')).status).toBe(401)
    await setMcpServerReach('this-computer')
    expect((await listTools(LAN, token)).status).toBe(403)
  })

  it('answers 404 when switched off, before reach and auth', async () => {
    await setMcpServerEnabled(false)
    expect((await listTools(LAN, null)).status).toBe(404)
    expect((await listTools('127.0.0.1', null)).status).toBe(404)
  })

  it('settings say the choice applies, with the reach and this machine\'s IPv4 addresses; PUT changes it', async () => {
    const before = await (await app.request('/api/mcp-server', {}, socket('127.0.0.1'))).json()
    expect(before.reach).toMatchObject({ applies: true, value: 'this-computer' })
    expect(Array.isArray(before.reach.networkAddresses)).toBe(true)
    for (const address of before.reach.networkAddresses) expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    const put = await app.request('/api/mcp-server/reach', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reach: 'network' }) }, socket('127.0.0.1'))
    expect(put.status).toBe(200)
    expect((await put.json()).reach.value).toBe('network')
    const bad = await app.request('/api/mcp-server/reach', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reach: 'everyone' }) }, socket('127.0.0.1'))
    expect(bad.status).toBe(400)
    const extra = await app.request('/api/mcp-server/reach', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reach: 'network', x: 1 }) }, socket('127.0.0.1'))
    expect(extra.status).toBe(400)
  })

  it('the settings routes themselves stay loopback-only (LocalModeAuth), like the rest of /api', async () => {
    expect((await app.request('/api/mcp-server', {}, socket(LAN))).status).toBe(403)
  })
})

describe('/mcp reach outside the desktop app', () => {
  it('checks no source: the infrastructure decides, and the token is what is asked', async () => {
    setProcessType(undefined)
    const token = await getOrCreateMcpInstallationToken()
    expect((await listTools(LAN, token)).status).toBe(200)
    expect((await listTools(LAN, null)).status).toBe(401)
    const status = await (await app.request('/api/mcp-server', {}, socket(LAN))).json()
    expect(status.reach).toEqual({ applies: false, value: 'this-computer', networkAddresses: [] })
    const put = await app.request('/api/mcp-server/reach', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reach: 'network' }) }, socket(LAN))
    expect(put.status).toBe(409)
  })
})
