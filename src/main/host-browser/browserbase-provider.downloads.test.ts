/**
 * The Browserbase and platform providers' downloads: each read checks the
 * session the container names against the agent's context mapping (the
 * database's, so any process answers), then goes to Browserbase's Downloads
 * API, directly or through the platform's proxy. Against a fake Browserbase
 * that answers as the real one did (2026-11-27).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ mappings: new Map<string, string>() }))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => ({ apiKeys: {}, app: {} }),
  getEffectiveBrowserbaseApiKey: async () => 'bb-test',
  effectiveBrowserbaseApiKeyFrom: () => 'bb-test',
  effectiveBrowserbaseProjectIdFrom: () => 'proj',
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: async () => 'platform-token',
  platformAccessTokenFrom: () => 'platform-token',
}))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://proxy.example' }))
vi.mock('./context-map-store', () => ({
  readContextMapping: async (provider: string, key: string) => h.mappings.get(`${provider}:${key}`) ?? null,
  getOrCreateMapping: async () => 'unused',
}))
vi.mock('./google-passkey-recovery', () => ({ GooglePasskeyRecovery: class { watch() {} stop() {} } }))

import { BrowserbaseProvider } from './browserbase-provider'
import { PlatformBrowserProvider } from './platform-provider'
import { DownloadsUnsupportedError, SessionNotOwnedError } from './downloads'

/** Paths the fake platform proxy passes through to Browserbase (null: all of them). */
let proxyAllows: RegExp[] | null
let requests: string[]

beforeEach(() => {
  h.mappings = new Map([['browserbase:agent-a', 'ctx-a'], ['platform:agent-a', 'ctx-a']])
  proxyAllows = null
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const { origin, pathname } = new URL(url)
    requests.push(`${origin}${pathname}`)
    let path: string
    if (origin === 'https://api.browserbase.com') {
      if (headers['X-BB-API-Key'] !== 'bb-test') return Response.json({ error: 'Unauthorized' }, { status: 401 })
      path = pathname.replace(/^\/v1/, '')
    } else {
      if (headers.Authorization !== 'Bearer platform-token') return Response.json({ error: 'Unauthorized' }, { status: 401 })
      path = pathname.replace(/^\/v1\/browserbase/, '')
      if (proxyAllows && !proxyAllows.some((rule) => rule.test(path))) return Response.json({ error: 'Not found' }, { status: 404 })
    }
    if (path === '/sessions/sess-a') return Response.json({ id: 'sess-a', status: 'COMPLETED', contextId: 'ctx-a' })
    if (path === '/sessions/sess-b') return Response.json({ id: 'sess-b', status: 'RUNNING', contextId: 'ctx-b' })
    if (path === '/downloads') return Response.json({ downloads: [{ id: 'dl-1', sessionId: 'sess-a', filename: 'guid-1', size: 4 }], total: 1 })
    if (path === '/downloads/dl-1' && headers.Accept === 'application/octet-stream') return new Response('file')
    return Response.json({ error: 'not found' }, { status: 404 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe.each([
  ['Browserbase', () => new BrowserbaseProvider()],
  ['platform', () => new PlatformBrowserProvider()],
])('%s downloads', (_name, create) => {
  it("lists and reads the agent's session, with nothing kept from a launch", async () => {
    const provider = create()
    expect(await provider.listDownloads('agent-a', 'sess-a')).toEqual([{ name: 'guid-1', size: 4 }])
    expect((await provider.readDownload('agent-a', 'sess-a', { guid: 'guid-1' }))?.toString()).toBe('file')
    expect(await provider.readDownload('agent-a', 'sess-a', { guid: 'guid-2' })).toBeNull()
  })

  it("refuses another agent's session before any download is read", async () => {
    const provider = create()
    await expect(provider.readDownload('agent-a', 'sess-b', { guid: 'guid-1' })).rejects.toBeInstanceOf(SessionNotOwnedError)
    await expect(provider.listDownloads('agent-b', 'sess-a')).rejects.toBeInstanceOf(SessionNotOwnedError)
    expect(requests.some((r) => r.includes('/downloads'))).toBe(false)
  })
})

describe('platform downloads through a proxy that does not pass them through', () => {
  it('say so at once, instead of reading as a file not there yet', async () => {
    proxyAllows = [/^\/sessions$/, /^\/contexts$/, /^\/sessions\/[^/]+$/, /^\/sessions\/[^/]+\/debug$/]
    const provider = new PlatformBrowserProvider()
    await expect(provider.readDownload('agent-a', 'sess-a', { guid: 'guid-1' })).rejects.toBeInstanceOf(DownloadsUnsupportedError)
    await expect(provider.listDownloads('agent-a', 'sess-a')).rejects.toBeInstanceOf(DownloadsUnsupportedError)
  })
})
