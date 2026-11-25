// @libsql-must-pass
/**
 * A client that identifies itself with a Client ID Metadata Document: its
 * `client_id` is an https URL, and the server fetches and validates the
 * document there on first use. The document is served by a local fixture
 * through the e2e seam (cimd-transport.ts), which only maps the host named
 * here; everything else in the flow is the production path.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeJwt } from 'jose'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'

const BASE = 'http://localhost:47891'
const CIMD_HOST = 'cimd.gamut-e2e.dev'
const CLIENT_ID = `https://${CIMD_HOST}/client.json`
vi.hoisted(() => {
  process.env.AUTH_MODE = 'true'
  process.env.TRUSTED_ORIGINS = 'http://localhost:47891'
  process.env.BETTER_AUTH_SECRET = 'mcp-oauth-cimd-secret-0123456789abcdef0123456789abcdef'
  process.env.AUTH_PROVIDERS_JSON = '[]'
  process.env.E2E_MOCK = 'true'
})

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

import app from './index'
import { setMcpServerEnabled } from '@shared/lib/mcp-server/mcp-server-settings'
import { mutateSettings } from '@shared/lib/config/settings'
import { resetAuth } from '@shared/lib/auth'
import * as flow from '@shared/lib/mcp-server/oauth/testing/oauth-flow'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'

const options: flow.FlowOptions = { base: BASE, fetch: async (path, init) => app.request(`${BASE}${path}`, init) }
let server: Server
let document: Record<string, unknown>
let served = 0

beforeAll(async () => {
  server = createServer((request, response) => {
    served++
    if (request.url !== '/client.json' && request.url !== '/other.json') {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(document))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.GAMUT_E2E_CIMD_HOSTS = JSON.stringify({ [CIMD_HOST]: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
  handle = await createTestDatabase()
  resetAuth()
  await mutateSettings((draft) => { draft.auth = { ...draft.auth, signupMode: 'open', requireAdminApproval: false } })
  await setMcpServerEnabled(true)
})

afterAll(async () => {
  await backgroundSettled()
  await handle.close()
  resetAuth()
  delete process.env.GAMUT_E2E_CIMD_HOSTS
  await new Promise((resolve) => server.close(resolve))
})

describe('a client ID metadata document client', () => {
  it('is fetched, shown as verified by its host, and connects', async () => {
    document = {
      client_id: CLIENT_ID,
      client_name: 'Document Client',
      redirect_uris: [flow.TEST_REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }
    const person = await flow.signUp(options, 'cimd-person@example.com')
    const tokens = await flow.connectClient(options, person.cookie, CLIENT_ID)
    expect(served).toBeGreaterThan(0)
    expect(decodeJwt(tokens.access_token).azp).toBe(CLIENT_ID)
    await backgroundSettled()
    expect(vi.mocked(trackServerEvent)).toHaveBeenCalledWith('mcp_client_connected', { client_name: 'Document Client', registration: 'metadata-document', scopes: ['gamut:read', 'gamut:run'], first_connection: true })
    // The client id is a URL on the client's host: never in analytics.
    expect(JSON.stringify(vi.mocked(trackServerEvent).mock.calls)).not.toContain(CIMD_HOST)

    const info = await (await options.fetch(`/api/mcp-server/oauth/consent-client?client_id=${encodeURIComponent(CLIENT_ID)}&redirect_uri=${encodeURIComponent(flow.TEST_REDIRECT_URI)}`, { headers: { cookie: person.cookie } })).json()
    expect(info).toMatchObject({ name: 'Document Client', registration: 'metadata-document', documentHost: CIMD_HOST, redirectHost: '127.0.0.1 (this computer)' })

    const call = await options.fetch('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }),
    })
    expect(call.status).toBe(200)
  })

  it('refuses a document whose client_id is not the URL it was fetched from', async () => {
    document = { client_id: 'https://someone-else.example/client.json', client_name: 'Impostor', redirect_uris: [flow.TEST_REDIRECT_URI], token_endpoint_auth_method: 'none' }
    const person = await flow.signIn(options, 'cimd-person@example.com')
    // A new URL on the same host, so nothing is cached from the first test.
    const before = served
    const response = await flow.authorize(options, person, { clientId: `https://${CIMD_HOST}/other.json` })
    expect(served).toBe(before + 1)
    expect(response.headers.get('location') ?? '').not.toMatch(/^\/oauth\/consent/)
    expect(response.headers.get('location') ?? '').not.toContain('code=')
  })
})
