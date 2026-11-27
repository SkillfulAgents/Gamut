/**
 * The two providers that run on Browserbase (direct, and through the platform
 * proxy), against a fake Browserbase that keeps its sessions. Each provider
 * instance stands in for one process that serves the tenant: a launch, the
 * next launch and the stop can each reach a different one, and a process that
 * starts over is a new instance. They share AppState (installed by the test
 * setup) and the context mapping, as real processes do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'

const h = vi.hoisted(() => ({
  watch: vi.fn(),
  stopWatch: vi.fn(),
  settings: { apiKeys: {} as { browserbaseApiKey?: string; browserbaseProjectId?: string }, app: {} as Record<string, unknown> },
  platformToken: null as string | null,
  mappings: new Map<string, string>(),
}))
vi.mock('./google-passkey-recovery', () => ({
  GooglePasskeyRecovery: class { watch = h.watch; stop = h.stopWatch },
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => h.settings,
  getEffectiveBrowserbaseApiKey: async () => h.settings.apiKeys.browserbaseApiKey,
  effectiveBrowserbaseApiKeyFrom: (settings: typeof h.settings) => settings.apiKeys.browserbaseApiKey,
  effectiveBrowserbaseProjectIdFrom: (settings: typeof h.settings) => settings.apiKeys.browserbaseProjectId,
}))
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: async () => h.platformToken,
  platformAccessTokenFrom: () => h.platformToken,
}))
vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformProxyBaseUrl: () => 'https://platform.test' }))
// The mapping is in the database, so every process sees it; its own semantics are tested in context-map-store.test.ts.
vi.mock('./context-map-store', () => ({
  getOrCreateMapping: async (provider: string, key: string, create: () => Promise<string>) => {
    const k = `${provider}:${key}`
    if (!h.mappings.has(k)) h.mappings.set(k, await create())
    return h.mappings.get(k)!
  },
}))

import { BrowserbaseProvider } from './browserbase-provider'
import { PlatformBrowserProvider } from './platform-provider'
import type { HostBrowserProvider } from './types'
import { FakeBrowserbase } from './testing/fake-browserbase'

let bb: FakeBrowserbase

/** Lets everything already queued run, so launches under way reach their next request. */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const PROVIDERS: Array<{ name: string; make: () => HostBrowserProvider; signIn: () => void; signOut: () => void }> = [
  {
    name: 'BrowserbaseProvider',
    make: () => new BrowserbaseProvider(),
    signIn: () => {
      h.settings.apiKeys = { browserbaseApiKey: 'bb-key', browserbaseProjectId: 'proj-1' }
    },
    signOut: () => {
      h.settings.apiKeys = {}
    },
  },
  {
    name: 'PlatformBrowserProvider',
    make: () => new PlatformBrowserProvider(),
    signIn: () => {
      h.platformToken = 'plat-token'
    },
    signOut: () => {
      h.platformToken = null
    },
  },
]

beforeEach(() => {
  bb = new FakeBrowserbase()
  vi.stubGlobal('fetch', bb.fetch)
  h.watch.mockClear()
  h.stopWatch.mockClear()
  h.mappings.clear()
  h.settings.app = {}
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each(PROVIDERS)('$name', ({ make, signIn, signOut }) => {
  beforeEach(() => signIn())
  afterEach(() => signOut())

  describe('in one process', () => {
    it("opens one session and hands the container its debug URL", async () => {
      const provider = make()

      expect(await provider.launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-1' })

      expect(bb.created).toEqual(['sess-1'])
      expect(provider.isRunning('agent-a')).toBe(true)
      expect(h.watch).toHaveBeenCalledWith('agent-a', 'wss://debug.test/sess-1')
    })

    it('uses the session again on the next launch, and releases it on stop', async () => {
      const provider = make()
      await provider.launch('agent-a', {}, 'agent-a')

      expect(await provider.launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-1' })
      await provider.stop('agent-a')

      expect(bb.created).toEqual(['sess-1'])
      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual([])
      expect(provider.isRunning('agent-a')).toBe(false)
      expect(provider.isRunning()).toBe(false)
    })

    it('opens a new session after a stop', async () => {
      const provider = make()
      await provider.launch('agent-a', {}, 'agent-a')
      await provider.stop('agent-a')

      expect(await provider.launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })
      expect(bb.running()).toEqual(['sess-2'])
    })

    it('hands over the single-use connect URL when a new session has no debug URL, and watches nothing', async () => {
      const provider = make()
      bb.debugBroken.add('sess-1')

      expect(await provider.launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://connect.test/sess-1' })

      expect(h.watch).not.toHaveBeenCalled()
      expect(h.stopWatch).toHaveBeenCalledWith('agent-a')
    })

    it('keeps each agent on its own session', async () => {
      const provider = make()
      const a = await provider.launch('agent-a', {}, 'agent-a')
      const b = await provider.launch('agent-b', {}, 'agent-b')

      expect(a).not.toEqual(b)
      await provider.stop('agent-a')
      expect(bb.running()).toEqual(['sess-2'])
      expect(provider.isRunning('agent-b')).toBe(true)
    })
  })

  describe('across processes', () => {
    it("uses the agent's session when the next launch reaches another process", async () => {
      const first = await make().launch('agent-a', {}, 'agent-a')

      const second = await make().launch('agent-a', {}, 'agent-a')

      expect(second).toEqual(first)
      expect(bb.created).toEqual(['sess-1'])
      expect(bb.releaseAsked).toEqual([])
    })

    it('releases the session when the stop reaches another process', async () => {
      const launching = make()
      await launching.launch('agent-a', {}, 'agent-a')
      await make().launch('agent-a', {}, 'agent-a')

      await make().stop('agent-a')

      expect(bb.created).toEqual(['sess-1'])
      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual([])
    })

    it('releases a session opened before the process started over', async () => {
      await make().launch('agent-a', {}, 'agent-a')

      // Nothing but the stop ever reaches the new process.
      const startedOver = make()
      expect(startedOver.isRunning('agent-a')).toBe(false)
      await startedOver.stop('agent-a')

      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual([])
    })

    it('does not go back to a session another process stopped', async () => {
      const first = make()
      await first.launch('agent-a', {}, 'agent-a')
      await make().stop('agent-a')

      // The first process still holds the old session in its own map.
      expect(await first.launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })
      expect(bb.running()).toEqual(['sess-2'])
    })

    it('follows the session another process replaced', async () => {
      const first = make()
      await first.launch('agent-a', {}, 'agent-a')
      bb.sessions.set('sess-1', 'TIMED_OUT')
      await make().launch('agent-a', {}, 'agent-a')

      // The first process holds sess-1; the agent's browser is sess-2 now.
      expect(await first.launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })
      await first.stop('agent-a')

      expect(bb.created).toEqual(['sess-1', 'sess-2'])
      expect(bb.releaseAsked).toEqual(['sess-2'])
    })

    it('releases once when stops reach several processes at once', async () => {
      await make().launch('agent-a', {}, 'agent-a')

      await Promise.all([make().stop('agent-a'), make().stop('agent-a'), make().stop('agent-a')])

      expect(bb.releaseAsked).toEqual(['sess-1'])
    })

    it('leaves one session when launches reach two processes at once', async () => {
      const creates = bb.holdCreates()
      const launches = [make().launch('agent-a', {}, 'agent-a'), make().launch('agent-a', {}, 'agent-a')]
      // Both have read that the agent has no session, and both are creating one.
      await settle()
      expect(creates.waiting()).toBe(2)
      creates.resume()

      const [one, two] = await Promise.all(launches)

      expect(bb.created).toHaveLength(2)
      expect(bb.running()).toHaveLength(1)
      const [kept] = bb.running()
      expect(one).toEqual({ cdpUrl: `wss://debug.test/${kept}` })
      expect(two).toEqual(one)
      expect(bb.releaseAsked).toEqual(bb.created.filter((id) => id !== kept))
      // And the one kept is the one a later stop releases.
      await make().stop('agent-a')
      expect(bb.running()).toEqual([])
    })

    it('leaves one session when two launches reach one process at once', async () => {
      const provider = make()
      const creates = bb.holdCreates()
      const launches = [provider.launch('agent-a', {}, 'agent-a'), provider.launch('agent-a', {}, 'agent-a')]
      await settle()
      creates.resume()

      const [one, two] = await Promise.all(launches)

      expect(two).toEqual(one)
      expect(bb.running()).toHaveLength(1)
      await provider.stop('agent-a')
      expect(bb.running()).toEqual([])
    })

    it('answers the live view from a process that did not open the browser', async () => {
      await make().launch('agent-a', {}, 'agent-a')

      expect(await make().getDebugInfo!('agent-a')).toEqual({ pages: [{ id: 'page-1', url: 'https://example.com/', wsUrl: 'wss://debug.test/sess-1/page-1?t=signed' }] })
      expect(await make().getDebugInfo!('agent-b')).toBeNull()
    })
  })

  describe('a recorded session that cannot be used', () => {
    it.each(['COMPLETED', 'ERROR', 'TIMED_OUT'])('is replaced once it has ended (%s), and not released again', async (status) => {
      await make().launch('agent-a', {}, 'agent-a')
      bb.sessions.set('sess-1', status)

      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })

      expect(bb.releaseAsked).toEqual([])
      await make().stop('agent-a')
      expect(bb.releaseAsked).toEqual(['sess-2'])
    })

    it('is replaced and released when it runs but gives no debug URL', async () => {
      await make().launch('agent-a', {}, 'agent-a')
      bb.debugBroken.add('sess-1')

      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })

      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual(['sess-2'])
    })

    it('is replaced and released when it cannot be read', async () => {
      await make().launch('agent-a', {}, 'agent-a')
      bb.readBroken.add('sess-1')

      await make().launch('agent-a', {}, 'agent-a')

      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual(['sess-2'])
    })

    it('is replaced when the account no longer has it', async () => {
      await make().launch('agent-a', {}, 'agent-a')
      // Another account's key: this one has never heard of sess-1, and refuses to release it.
      bb.sessions.delete('sess-1')
      bb.releaseAnswers.push(404)

      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })
      await make().stop('agent-a')

      expect(bb.releaseAsked).toEqual(['sess-1', 'sess-2'])
      expect(bb.running()).toEqual([])
    })
  })

  describe('stop', () => {
    it('asks Browserbase nothing when the agent has no session', async () => {
      await make().stop('agent-a')

      expect(bb.requests).toEqual([])
    })

    it('leaves the session recorded while signed out, for a stop that can release it', async () => {
      const provider = make()
      await provider.launch('agent-a', {}, 'agent-a')
      bb.requests.length = 0

      signOut()
      await provider.stop('agent-a')
      expect(bb.requests).toEqual([])
      expect(provider.isRunning('agent-a')).toBe(false)

      signIn()
      await make().stop('agent-a')
      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual([])
    })

    it.each([500, 503, 429, 'network'] as const)('keeps the session recorded when its release does not get through (%s)', async (answer) => {
      await make().launch('agent-a', {}, 'agent-a')
      bb.releaseAnswers.push(answer)

      await make().stop('agent-a')
      expect(bb.running()).toEqual(['sess-1'])

      // The next launch finds it, and the next stop releases it.
      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-1' })
      await make().stop('agent-a')
      expect(bb.created).toEqual(['sess-1'])
      expect(bb.running()).toEqual([])
    })

    it('does not record a session again when its release is refused', async () => {
      await make().launch('agent-a', {}, 'agent-a')
      bb.releaseAnswers.push(404)

      await make().stop('agent-a')
      await make().stop('agent-a')

      expect(bb.releaseAsked).toEqual(['sess-1'])
    })

    it('never throws, whatever the release answers', async () => {
      await make().launch('agent-a', {}, 'agent-a')
      bb.releaseAnswers.push('network')

      await expect(make().stop('agent-a')).resolves.toBeUndefined()
    })

    it('releases what this process opened when the shared record cannot be reached', async () => {
      const provider = make()
      await provider.launch('agent-a', {}, 'agent-a')
      vi.spyOn(appState(), 'consume').mockRejectedValueOnce(new Error('AppState is unreachable'))

      await provider.stop('agent-a')

      expect(bb.releaseAsked).toEqual(['sess-1'])
    })

    it('stopAll releases the sessions this process holds, and only those', async () => {
      const mine = make()
      await mine.launch('agent-a', {}, 'agent-a')
      await mine.launch('agent-b', {}, 'agent-b')
      const other = make()
      await other.launch('agent-c', {}, 'agent-c')

      await mine.stopAll()

      expect(bb.releaseAsked.sort()).toEqual(['sess-1', 'sess-2'])
      expect(bb.running()).toEqual(['sess-3'])
      expect(mine.isRunning()).toBe(false)
      // The records went with them: the next launch opens a new session.
      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-4' })
    })

    it('stopAll leaves alone a browser the agent got from another process since', async () => {
      const mine = make()
      await mine.launch('agent-a', {}, 'agent-a')
      // The session this process holds ended, and another process opened the agent's next one.
      bb.sessions.set('sess-1', 'TIMED_OUT')
      await make().launch('agent-a', {}, 'agent-a')

      await mine.stopAll()

      expect(bb.releaseAsked).toEqual([])
      expect(bb.running()).toEqual(['sess-2'])
      // It is still the agent's browser: the next launch uses it, and a stop releases it.
      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-2' })
      await make().stop('agent-a')
      expect(bb.releaseAsked).toEqual(['sess-2'])
    })

    it('stopAll asks nothing for a session another process already stopped', async () => {
      const mine = make()
      await mine.launch('agent-a', {}, 'agent-a')
      await make().stop('agent-a')
      bb.requests.length = 0

      await mine.stopAll()

      expect(bb.requests).toEqual([])
    })

    it('stopAll releases what this process holds when the shared record cannot be reached', async () => {
      const mine = make()
      await mine.launch('agent-a', {}, 'agent-a')
      vi.spyOn(appState(), 'get').mockRejectedValueOnce(new Error('AppState is unreachable'))

      await mine.stopAll()

      expect(bb.releaseAsked).toEqual(['sess-1'])
    })
  })

  describe('a launch that fails', () => {
    it('records nothing when Browserbase refuses the session', async () => {
      bb.createStatus = 500
      await expect(make().launch('agent-a', {}, 'agent-a')).rejects.toThrow(/Failed to create .*session: 500/)

      bb.createStatus = 200
      expect(await make().launch('agent-a', {}, 'agent-a')).toEqual({ cdpUrl: 'wss://debug.test/sess-1' })
    })

    it('releases the new session when it cannot be recorded', async () => {
      vi.spyOn(appState(), 'compareAndSet').mockRejectedValueOnce(new Error('AppState is unreachable'))
      const provider = make()

      await expect(provider.launch('agent-a', {}, 'agent-a')).rejects.toThrow('AppState is unreachable')

      expect(bb.created).toEqual(['sess-1'])
      expect(bb.releaseAsked).toEqual(['sess-1'])
      expect(bb.running()).toEqual([])
      expect(provider.isRunning('agent-a')).toBe(false)
    })

    it('asks Browserbase nothing while signed out', async () => {
      signOut()

      await expect(make().launch('agent-a', {}, 'agent-a')).rejects.toThrow()
      expect(bb.requests).toEqual([])
    })
  })
})

describe('what each provider sends', () => {
  it('Browserbase: the API key on every request, and the project on a create and a release', async () => {
    h.settings.apiKeys = { browserbaseApiKey: 'bb-key', browserbaseProjectId: 'proj-1' }
    try {
      await new BrowserbaseProvider().launch('agent-a', {}, 'agent-a')
      await new BrowserbaseProvider().stop('agent-a')
    } finally {
      h.settings.apiKeys = {}
    }

    expect(bb.fetch.mock.calls.every(([url]) => String(url).startsWith('https://api.browserbase.com/v1/'))).toBe(true)
    expect(bb.requests.every((request) => request.headers['X-BB-API-Key'] === 'bb-key')).toBe(true)
    const create = bb.requests.find((request) => request.method === 'POST' && request.path === '/sessions')
    expect(create?.body).toEqual({ projectId: 'proj-1', keepAlive: true, browserSettings: { context: { id: 'ctx-1', persist: true } } })
    const release = bb.requests.find((request) => request.method === 'POST' && request.path === '/sessions/sess-1')
    expect(release?.body).toEqual({ projectId: 'proj-1', status: 'REQUEST_RELEASE' })
  })

  it('Platform: the access token on every request, through the proxy, and no project', async () => {
    h.platformToken = 'plat-token'
    try {
      await new PlatformBrowserProvider().launch('agent-a', {}, 'agent-a')
      await new PlatformBrowserProvider().stop('agent-a')
    } finally {
      h.platformToken = null
    }

    expect(bb.fetch.mock.calls.every(([url]) => String(url).startsWith('https://platform.test/v1/browserbase/'))).toBe(true)
    expect(bb.requests.every((request) => request.headers.Authorization === 'Bearer plat-token')).toBe(true)
    const create = bb.requests.find((request) => request.method === 'POST' && request.path === '/sessions')
    expect(create?.body).toEqual({ keepAlive: true, browserSettings: { context: { id: 'ctx-1', persist: true } } })
    const release = bb.requests.find((request) => request.method === 'POST' && request.path === '/sessions/sess-1')
    expect(release?.body).toEqual({ status: 'REQUEST_RELEASE' })
  })

  it('keeps the two providers apart: one does not use or stop the other\'s session', async () => {
    h.settings.apiKeys = { browserbaseApiKey: 'bb-key', browserbaseProjectId: 'proj-1' }
    h.platformToken = 'plat-token'
    try {
      await new BrowserbaseProvider().launch('agent-a', {}, 'agent-a')
      await new PlatformBrowserProvider().launch('agent-a', {}, 'agent-a')
      expect(bb.created).toEqual(['sess-1', 'sess-2'])

      await new PlatformBrowserProvider().stop('agent-a')
      expect(bb.running()).toEqual(['sess-1'])
    } finally {
      h.settings.apiKeys = {}
      h.platformToken = null
    }
  })
})
