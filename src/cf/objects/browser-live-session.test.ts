/**
 * SUP-1813 over the Cloudflare AppState: the Browserbase and Platform browser providers with the
 * org's AppState object behind them (its real class and client, on in-memory SQLite). Each isolate
 * has its own provider instance and its own AppState client, as a Worker isolate does; the object
 * is all they share. The providers' behavior is tested in full in
 * src/main/host-browser/browserbase-live-session.test.ts; this holds it to the same answers here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurableObjectNamespace } from 'cloudflare:workers'
import { closeAppState, initializeAppState, LOCAL_APP_STATE_SCOPE } from '@shared/lib/app-state'
import { CloudflareAppState, type AppStateDurableObject } from './cloudflare-app-state'
import { memoryHub, namespaceOf, testObject } from './testing/app-state-object'
import { FakeBrowserbase } from '../../main/host-browser/testing/fake-browserbase'

const h = vi.hoisted(() => ({ mappings: new Map<string, string>() }))
vi.mock('../../main/host-browser/google-passkey-recovery', () => ({ GooglePasskeyRecovery: class { watch() {} stop() {} } }))
vi.mock('@shared/lib/config/settings', () => {
  const settings = { apiKeys: { browserbaseApiKey: 'bb-key', browserbaseProjectId: 'proj-1' }, app: {} }
  return {
    getSettings: async () => settings,
    getEffectiveBrowserbaseApiKey: async () => settings.apiKeys.browserbaseApiKey,
    effectiveBrowserbaseApiKeyFrom: () => settings.apiKeys.browserbaseApiKey,
    effectiveBrowserbaseProjectIdFrom: () => settings.apiKeys.browserbaseProjectId,
  }
})
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: async () => 'plat-token',
  platformAccessTokenFrom: () => 'plat-token',
}))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://platform.test' }))
// In the database for real, which every isolate reads.
vi.mock('../../main/host-browser/context-map-store', () => ({
  getOrCreateMapping: async (provider: string, key: string, create: () => Promise<string>) => {
    const k = `${provider}:${key}`
    if (!h.mappings.has(k)) h.mappings.set(k, await create())
    return h.mappings.get(k)!
  },
}))

import { BrowserbaseProvider } from '../../main/host-browser/browserbase-provider'
import { PlatformBrowserProvider } from '../../main/host-browser/platform-provider'

let bb: FakeBrowserbase
let objects: DurableObjectNamespace<AppStateDurableObject>

/** Runs `work` as one isolate does: with its own AppState client of the org's object. */
async function inIsolate<T>(work: () => Promise<T>): Promise<T> {
  await closeAppState()
  await initializeAppState(new CloudflareAppState(objects, { scope: LOCAL_APP_STATE_SCOPE, hub: memoryHub() }))
  return work()
}

beforeEach(() => {
  bb = new FakeBrowserbase()
  vi.stubGlobal('fetch', bb.fetch)
  h.mappings.clear()
  objects = namespaceOf(testObject())
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each([
  ['BrowserbaseProvider', () => new BrowserbaseProvider()],
  ['PlatformBrowserProvider', () => new PlatformBrowserProvider()],
])('%s across isolates', (_name, make) => {
  it('opens one session for a launch in one isolate and the next launch in another, and a third releases it', async () => {
    const first = await inIsolate(() => make().launch('agent-a', {}, 'agent-a'))
    const second = await inIsolate(() => make().launch('agent-a', {}, 'agent-a'))
    await inIsolate(() => make().stop('agent-a'))

    expect(second).toEqual(first)
    expect(bb.created).toEqual(['sess-1'])
    expect(bb.releaseAsked).toEqual(['sess-1'])
    expect(bb.running()).toEqual([])
  })

  it('releases a session from an isolate that only ever sees the stop, as after a deploy', async () => {
    await inIsolate(() => make().launch('agent-a', {}, 'agent-a'))

    await inIsolate(() => make().stop('agent-a'))

    expect(bb.releaseAsked).toEqual(['sess-1'])
    expect(bb.running()).toEqual([])
  })

  it('leaves one session when two launches run at once', async () => {
    await inIsolate(async () => {})
    const creates = bb.holdCreates()
    const launches = [make().launch('agent-a', {}, 'agent-a'), make().launch('agent-a', {}, 'agent-a')]
    // Both have read that the agent has no session, and both are creating one.
    for (let i = 0; i < 200 && creates.waiting() < 2; i++) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(creates.waiting()).toBe(2)
    creates.resume()

    const [one, two] = await Promise.all(launches)

    expect(two).toEqual(one)
    expect(bb.running()).toHaveLength(1)
    await inIsolate(() => make().stop('agent-a'))
    expect(bb.running()).toEqual([])
  })

  it('replaces an ended session, keeps one whose release failed, and releases once of several stops', async () => {
    await inIsolate(() => make().launch('agent-a', {}, 'agent-a'))
    bb.sessions.set('sess-1', 'TIMED_OUT')
    expect(await inIsolate(() => make().launch('agent-a', {}, 'agent-a'))).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })

    bb.releaseAnswers.push(503)
    await inIsolate(() => make().stop('agent-a'))
    expect(bb.running()).toEqual(['sess-2'])
    expect(await inIsolate(() => make().launch('agent-a', {}, 'agent-a'))).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })

    bb.releaseAsked.length = 0
    await Promise.all([make().stop('agent-a'), make().stop('agent-a'), make().stop('agent-a')])
    expect(bb.releaseAsked).toEqual(['sess-2'])
    expect(bb.running()).toEqual([])
  })
})
