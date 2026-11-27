/**
 * SUP-1813 — an agent's cloud browser must be the same one whichever process
 * serves the container's calls. The container asks the host to open its
 * browser (`launch-host-browser`) and to close it (`stop-host-browser`), and a
 * deployment that serves a tenant from several processes can answer each call
 * in a different one; a process that starts over has forgotten every browser
 * it opened. Before, each process knew only its own: the next open made a
 * second browser, and the close released nothing.
 *
 * These tests mount the REAL browser routes, the REAL IsAgent() middleware,
 * the REAL provider registry and the REAL Browserbase and Platform providers
 * over a fake Browserbase. `startProcess()` resets the module registry, so
 * each one starts with empty provider maps, as a new process does, while
 * AppState (held on globalThis) stays shared between them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeBrowserbase } from '../../main/host-browser/testing/fake-browserbase'

const h = vi.hoisted(() => ({
  settings: {
    apiKeys: { browserbaseApiKey: 'bb-key', browserbaseProjectId: 'proj-1' },
    app: { hostBrowserProvider: 'browserbase' } as Record<string, unknown>,
  },
  mappings: new Map<string, string>(),
}))

vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => (token.endsWith('-token') ? token.slice(0, -'-token'.length) : null),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => h.settings,
  getEffectiveBrowserbaseApiKey: async () => h.settings.apiKeys.browserbaseApiKey,
  effectiveBrowserbaseApiKeyFrom: (settings: typeof h.settings) => settings.apiKeys.browserbaseApiKey,
  effectiveBrowserbaseProjectIdFrom: (settings: typeof h.settings) => settings.apiKeys.browserbaseProjectId,
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: async () => 'plat-token',
  platformAccessTokenFrom: () => 'plat-token',
}))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://platform.test' }))
// In the database for real, so every process sees it.
vi.mock('../../main/host-browser/context-map-store', () => ({
  readContextMapping: async (provider: string, key: string) => h.mappings.get(`${provider}:${key}`) ?? null,
  getOrCreateMapping: async (provider: string, key: string, create: () => Promise<string>) => {
    const k = `${provider}:${key}`
    if (!h.mappings.has(k)) h.mappings.set(k, await create())
    return h.mappings.get(k)!
  },
}))
vi.mock('../../main/host-browser/google-passkey-recovery', () => ({
  GooglePasskeyRecovery: class { watch() {} stop() {} },
}))
// Not under test, and their imports reach for this machine's Chrome and other accounts.
vi.mock('../../main/host-browser/chrome-provider', () => ({
  ChromeProvider: class { id = 'chrome'; name = 'Chrome'; onExternalClose = null; isRunning = () => false; stop = async () => {}; stopAll = async () => {} },
}))
vi.mock('../../main/host-browser/steel-provider', () => ({
  SteelProvider: class { id = 'steel'; name = 'Steel'; onExternalClose = null; isRunning = () => false; stop = async () => {}; stopAll = async () => {} },
}))
vi.mock('../../main/host-browser/tabtender-provider', () => ({
  TabtenderProvider: class { id = 'tabtender'; name = 'Tab Tender'; onExternalClose = null; isRunning = () => false; stop = async () => {}; stopAll = async () => {} },
}))

vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({ getClient: () => ({ fetch: vi.fn() }) }) }
})
// auth.ts dependencies: the REAL IsAgent() runs, and never touches the db or auth mode.
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (_id: string, fn: () => unknown) => fn(),
  runWithOptionalUser: (_id: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({
  agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {},
}))

let bb: FakeBrowserbase

/** A process that has just started: its own copy of every module, so no browser it could know of. */
async function startProcess() {
  vi.resetModules()
  const { Hono } = await import('hono')
  const { default: browser } = await import('./browser')
  const hostBrowser = await import('../../main/host-browser')
  const app = new Hono()
  app.route('/api/browser', browser)
  return {
    /** A call from the agent's container, with its own token. */
    async post(path: string, agent = 'agent-a') {
      const response = await app.request(`http://localhost/api/browser/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${agent}-token` },
        body: JSON.stringify({ agentId: agent }),
      })
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    },
    /** What deleting the agent does to its browsers (agents.ts). */
    stopForDeletion: (agent = 'agent-a') => hostBrowser.stopInstanceOnAllProviders(agent),
    isRunning: async (agent = 'agent-a') => (await hostBrowser.getActiveProvider())!.isRunning(agent),
  }
}

beforeEach(() => {
  bb = new FakeBrowserbase()
  vi.stubGlobal('fetch', bb.fetch)
  h.mappings.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(['browserbase', 'platform'])('host browser routes with the %s provider, served by several processes', (providerId) => {
  beforeEach(() => {
    h.settings.app = { hostBrowserProvider: providerId }
  })

  it('hands back the same browser when the next open reaches another process', async () => {
    const opened = await (await startProcess()).post('launch-host-browser')
    expect(opened).toEqual({ status: 200, body: { cdpUrl: 'wss://debug.test/sess-1' } })

    const again = await (await startProcess()).post('launch-host-browser')

    expect(again).toEqual(opened)
    expect(bb.created).toEqual(['sess-1'])
    expect(bb.running()).toEqual(['sess-1'])
  })

  it('releases the browser when the close reaches a process that never opened it', async () => {
    await (await startProcess()).post('launch-host-browser')

    const closing = await startProcess()
    expect(await closing.isRunning()).toBe(false)
    expect(await closing.post('stop-host-browser')).toEqual({ status: 200, body: { success: true } })

    expect(bb.releaseAsked).toEqual(['sess-1'])
    expect(bb.running()).toEqual([])
  })

  it('goes through an open, a process starting over, a second open and a close with one session', async () => {
    await (await startProcess()).post('launch-host-browser')
    await (await startProcess()).post('launch-host-browser')
    await (await startProcess()).post('stop-host-browser')

    expect(bb.created).toEqual(['sess-1'])
    expect(bb.releaseAsked).toEqual(['sess-1'])
    // And the browser after that is a new one.
    expect((await (await startProcess()).post('launch-host-browser')).body).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })
  })

  it('releases the browser when the agent is deleted from a process that never opened it', async () => {
    await (await startProcess()).post('launch-host-browser')

    await (await startProcess()).stopForDeletion()

    expect(bb.releaseAsked).toEqual(['sess-1'])
    expect(bb.running()).toEqual([])
  })

  it('answers the live view from a process that never opened the browser', async () => {
    await (await startProcess()).post('launch-host-browser')

    const info = await (await startProcess()).post('debug-info')

    expect(info).toEqual({ status: 200, body: { pages: [{ id: 'page-1', url: 'https://example.com/', wsUrl: 'wss://debug.test/sess-1/page-1?t=signed' }] } })
  })

  it("leaves another agent's browser alone", async () => {
    await (await startProcess()).post('launch-host-browser', 'agent-a')
    await (await startProcess()).post('launch-host-browser', 'agent-b')

    const other = await startProcess()
    await other.post('stop-host-browser', 'agent-b')
    await other.stopForDeletion('agent-c')

    expect(bb.releaseAsked).toEqual(['sess-2'])
    expect(bb.running()).toEqual(['sess-1'])
  })

  it('leaves one browser when two opens reach two processes at once', async () => {
    const [first, second] = [await startProcess(), await startProcess()]
    const creates = bb.holdCreates()
    const opens = [first.post('launch-host-browser'), second.post('launch-host-browser')]
    for (let i = 0; i < 200 && creates.waiting() < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(creates.waiting()).toBe(2)
    creates.resume()

    const [one, two] = await Promise.all(opens)

    expect(one.status).toBe(200)
    expect(two).toEqual(one)
    expect(bb.running()).toHaveLength(1)
    expect(one.body).toEqual({ cdpUrl: `wss://debug.test/${bb.running()[0]}` })
  })
})
