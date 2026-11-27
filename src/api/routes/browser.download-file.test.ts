import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

// POST /api/browser/downloads and /api/browser/download-file: a container
// asking for the files its cloud browser downloaded. Mounted with the REAL
// IsAgent() middleware, the token resolving to 'agent-a', like the SUP-216 tests.

const mockValidateProxyToken = vi.fn<(token: string) => Promise<string | null>>()
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: (token: string) => mockValidateProxyToken(token),
}))

const mockProvider: { name: string; readDownload?: ReturnType<typeof vi.fn>; listDownloads?: ReturnType<typeof vi.fn> } = { name: 'Browserbase' }
const mockGetActiveProvider = vi.fn<() => typeof mockProvider | null>(() => mockProvider)
vi.mock('../../main/host-browser', () => ({
  getActiveProvider: () => mockGetActiveProvider(),
  setOnExternalClose: vi.fn(),
}))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ app: {} }),
}))

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({ getClient: () => ({ fetch: vi.fn() }) }) }
})

vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (_id: string, fn: () => unknown) => fn(),
  runWithOptionalUser: (_id: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {},
}))

import browser from './browser'
import { DownloadTooLargeError, DownloadsUnsupportedError, SessionNotOwnedError } from '../../main/host-browser/downloads'

function post(route: 'downloads' | 'download-file', body: unknown) {
  const app = new Hono()
  app.route('/api/browser', browser)
  return app.request(`http://localhost/api/browser/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer agent-a-token' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/browser/download-file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockProvider.name = 'Browserbase'
    mockProvider.readDownload = vi.fn()
    mockProvider.listDownloads = vi.fn()
    mockGetActiveProvider.mockReturnValue(mockProvider)
    mockValidateProxyToken.mockResolvedValue('agent-a')
  })

  it("answers the provider's bytes, for the token's own agent and the session the container names", async () => {
    mockProvider.readDownload!.mockResolvedValue(Buffer.from('{"type":"service_account"}'))
    const res = await post('download-file', { agentId: 'agent-a', sessionId: 'sess-1', guid: 'guid-1' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(await res.text()).toBe('{"type":"service_account"}')
    expect(mockProvider.readDownload).toHaveBeenCalledWith('agent-a', 'sess-1', { guid: 'guid-1' })
  })

  it("never acts for another agent's token, and refuses a session the provider says is not this agent's", async () => {
    expect((await post('download-file', { agentId: 'agent-b', sessionId: 'sess-1', guid: 'guid-1' })).status).toBe(403)
    expect(mockProvider.readDownload).not.toHaveBeenCalled()
    mockProvider.readDownload!.mockRejectedValue(new SessionNotOwnedError())
    const res = await post('download-file', { sessionId: 'sess-of-agent-b', guid: 'guid-1' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("That browser session is not this agent's")
  })

  it('answers 404 while the provider does not have the file yet', async () => {
    mockProvider.readDownload!.mockResolvedValue(null)
    expect((await post('download-file', { sessionId: 'sess-1', guid: 'guid-1' })).status).toBe(404)
  })

  it('answers 501 for a provider with no downloads to read, and when it says it has none', async () => {
    mockProvider.readDownload = undefined
    mockProvider.name = 'Tab Tender'
    const res = await post('download-file', { sessionId: 'sess-1', guid: 'guid-1' })
    expect(res.status).toBe(501)
    expect((await res.json()).error).toContain('Tab Tender keeps no copy')

    mockProvider.readDownload = vi.fn().mockRejectedValue(new DownloadsUnsupportedError("The platform's browser proxy does not serve the browser's downloads"))
    expect((await post('download-file', { sessionId: 'sess-1', guid: 'guid-1' })).status).toBe(501)

    mockGetActiveProvider.mockReturnValue(null)
    expect((await post('download-file', { sessionId: 'sess-1', guid: 'guid-1' })).status).toBe(501)
  })

  it('answers 413 for a file over the limit, and 502 when reading it failed', async () => {
    mockProvider.readDownload!.mockRejectedValue(new DownloadTooLargeError(200 * 1024 * 1024))
    expect((await post('download-file', { sessionId: 'sess-1', guid: 'guid-1' })).status).toBe(413)
    mockProvider.readDownload!.mockRejectedValue(new Error('Browserbase answered 500'))
    const res = await post('download-file', { sessionId: 'sess-1', guid: 'guid-1' })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('Browserbase answered 500')
  })

  it('refuses a body without a session or a guid', async () => {
    expect((await post('download-file', { guid: 'guid-1' })).status).toBe(400)
    expect((await post('download-file', { sessionId: 'sess-1' })).status).toBe(400)
    expect(mockProvider.readDownload).not.toHaveBeenCalled()
  })
})

describe('POST /api/browser/downloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProvider.name = 'Steel'
    mockProvider.listDownloads = vi.fn()
    mockGetActiveProvider.mockReturnValue(mockProvider)
    mockValidateProxyToken.mockResolvedValue('agent-a')
  })

  it("lists the session's stored files", async () => {
    mockProvider.listDownloads!.mockResolvedValue([{ name: 'guid-1', size: 3 }, { name: 'notes.txt', size: null }])
    const res = await post('downloads', { sessionId: 'sess-1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ files: [{ name: 'guid-1', size: 3 }, { name: 'notes.txt', size: null }] })
    expect(mockProvider.listDownloads).toHaveBeenCalledWith('agent-a', 'sess-1')
  })

  it("refuses another agent's session, and says when the provider keeps none", async () => {
    mockProvider.listDownloads!.mockRejectedValue(new SessionNotOwnedError())
    expect((await post('downloads', { sessionId: 'sess-of-agent-b' })).status).toBe(403)
    mockProvider.listDownloads = undefined
    expect((await post('downloads', { sessionId: 'sess-1' })).status).toBe(501)
    expect((await post('downloads', {})).status).toBe(400)
  })
})
