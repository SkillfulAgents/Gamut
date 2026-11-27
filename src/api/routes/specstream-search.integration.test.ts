// @libsql-must-pass
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { APP_VERSION } from '@shared/lib/config/version'

vi.mock('@shared/lib/proxy/token-store', () => ({ validateProxyToken: vi.fn(async () => 'test-agent') }))
vi.mock('@shared/lib/services/platform-auth-service', () => ({ getPlatformAccessToken: async () => null }))
vi.mock('@shared/lib/error-reporting', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { getActiveWebProvider, resolveEffectiveWebVendor } from '@shared/lib/web-provider'
import webFetch from './web-fetch'
import webSearch from './web-search'

let handle: TestDatabase
let testDb: TestDatabase['db']
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer isolated-test-token' }

beforeEach(async () => {
  for (const name of ['SPECSTREAM_API_KEY', 'YDC_API_KEY', 'PARALLEL_API_KEY', 'PLATFORM_TOKEN', 'EXA_API_KEY']) vi.stubEnv(name, '')
  handle = await createTestDatabase()
  testDb = handle.db
  await mutateSettings((s) => {
    s.webProvider = 'specstream'
    s.apiKeys = { specstreamApiKey: 'saved-key' }
    s.webBlockedSites = ['blocked.test']
  })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await handle.close()
})

it('serves search through the host route with the saved key, the site filter in the query and the operator policy applied', async () => {
  expect((await getSettings()).webProvider).toBe('specstream')
  expect(await resolveEffectiveWebVendor()).toBe('specstream')
  expect((await getActiveWebProvider())?.fetch).toBeTypeOf('function')
  const app = new Hono().route('/api/x-agent/web-search', webSearch)
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    seen.push(url)
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer saved-key')
    expect(headers.get('User-Agent')).toBe(`Gamut/${APP_VERSION}`)
    return new Response(JSON.stringify({ data: { sources: [
      { url: 'https://docs.python.org/3/library/asyncio-task.html', title: 'Coroutines and Tasks', snippet: 'asyncio.TaskGroup', published: '2025-02-04' },
      { url: 'https://blocked.test/page', title: 'Blocked', snippet: 'Must not reach the agent' },
    ] } }), { headers: { 'Content-Type': 'application/json' } })
  }))
  const res = await app.request('http://localhost/api/x-agent/web-search/search', {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ query: 'asyncio TaskGroup', numResults: 2, includeDomains: ['python.org'] }),
  })
  expect(res.status).toBe(200)
  const body = await res.json() as { hits: Array<{ url: string, title: string | null }>, warnings?: string[] }
  expect(body.hits.map((h) => h.url)).toEqual(['https://docs.python.org/3/library/asyncio-task.html'])
  expect(body.warnings?.length).toBeGreaterThan(0)
  expect(seen).toHaveLength(1)
  expect(new URLSearchParams(seen[0].split('?')[1]).get('q')).toBe('asyncio TaskGroup site:python.org')
})

it('serves page reading through the host route and reports an archived-only read as a failure', async () => {
  const app = new Hono().route('/api/x-agent/web-fetch', webFetch)
  let readFrom = 'live'
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.specstream.ai/v1/extract')
    expect(JSON.parse(String(init.body))).toEqual({ urls: ['https://example.com/report.pdf'], format: 'markdown' })
    return new Response(JSON.stringify({ data: { results: [
      { url: 'https://example.com/report.pdf', status: 'ok', title: 'Report', text: '# Report\n\nBody text', read_from: readFrom },
    ] } }), { headers: { 'Content-Type': 'application/json' } })
  }))
  const ok = await app.request('http://localhost/api/x-agent/web-fetch/fetch', {
    method: 'POST', headers: AUTH, body: JSON.stringify({ url: 'https://example.com/report.pdf' }),
  })
  expect(ok.status).toBe(200)
  expect(JSON.stringify(await ok.json())).toContain('Body text')

  readFrom = 'archive'
  const archived = await app.request('http://localhost/api/x-agent/web-fetch/fetch', {
    method: 'POST', headers: AUTH, body: JSON.stringify({ url: 'https://example.com/report.pdf' }),
  })
  expect(archived.status).toBeGreaterThanOrEqual(400)
  expect(JSON.stringify(await archived.json())).not.toContain('Body text')
})
