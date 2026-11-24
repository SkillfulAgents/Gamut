/**
 * `/mcp` in an auth-mode deployment before OAuth lands: not served at all,
 * whatever is sent, and the settings route says it is unavailable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'

// src/api/index.ts reads the mode once, when it is imported.
vi.hoisted(() => { process.env.AUTH_MODE = 'true' })

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

import app from './index'
import { getOrCreateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { isMcpServerEnabledFrom } from '@shared/lib/mcp-server/mcp-server-settings'

beforeAll(async () => {
  handle = await createTestDatabase()
})

afterAll(async () => {
  await backgroundSettled()
  await handle.close()
  delete process.env.AUTH_MODE
})

describe('/mcp in auth mode', () => {
  it('answers 404 to every request, even one carrying an installation token', async () => {
    const token = await getOrCreateMcpInstallationToken()
    const variants: Array<Record<string, string>> = [{}, { Authorization: `Bearer ${token}` }]
    for (const headers of variants) {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      })
      expect(response.status).toBe(404)
      expect(response.headers.get('www-authenticate')).toBeNull()
    }
  })

  it('defaults the switch to off there', () => {
    expect(isMcpServerEnabledFrom({})).toBe(false)
    expect(isMcpServerEnabledFrom({ mcpServer: { enabled: true } })).toBe(true)
  })

  it('keeps the settings route behind the session', async () => {
    expect((await app.request('/api/mcp-server')).status).toBe(401)
  })
})
