import { beforeEach, describe, it, expect, vi } from 'vitest'

// stopInstanceOnAllProviders must stop an instance's browser on EVERY
// provider, independent of which provider is currently selected in settings —
// the user can switch providers while a browser from the previous one is
// still running, and agent deletion must not leave that browser alive while
// its profile directory is removed.
//
// A cloud provider is asked whatever it reports as running: its browser can be
// one another process opened, or this one before it started over, and only its
// `stop` can find that. Chrome is asked only where this process runs it.

const h = vi.hoisted(() => {
  const created: Array<{ id: string; isRunning: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = []
  function makeProviderClass(id: string, running: (instanceId: string) => boolean) {
    return class {
      id = id
      name = id
      onExternalClose = null
      isRunning = vi.fn(running)
      stop = vi.fn(async () => {})
      stopAll = vi.fn(async () => {})
      detect = vi.fn()
      launch = vi.fn()
      constructor() {
        created.push(this as never)
      }
    }
  }
  return { created, makeProviderClass }
})

vi.mock('./chrome-provider', () => ({
  ChromeProvider: h.makeProviderClass('chrome', (instanceId: string) => instanceId === 'agent1'),
}))
vi.mock('./browserbase-provider', () => ({
  BrowserbaseProvider: h.makeProviderClass('browserbase', () => false),
}))
vi.mock('./platform-provider', () => ({
  PlatformBrowserProvider: h.makeProviderClass('platform', () => false),
}))
vi.mock('./steel-provider', () => ({
  SteelProvider: h.makeProviderClass('steel', () => false),
}))
vi.mock('./tabtender-provider', () => ({
  TabtenderProvider: h.makeProviderClass('tabtender', () => false),
}))

// The active provider is NOT chrome — proves the stop is provider-independent.
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => ({ app: { hostBrowserProvider: 'browserbase' } }),
}))

import { stopInstanceOnAllProviders } from './index'

const provider = (id: string) => h.created.find((p) => p.id === id)!
const CLOUD = ['browserbase', 'platform', 'steel', 'tabtender']

describe('stopInstanceOnAllProviders', () => {
  beforeEach(() => {
    for (const p of h.created) {
      p.stop.mockReset()
      p.stop.mockResolvedValue(undefined)
    }
  })

  it('stops a running instance on a non-active provider', async () => {
    await stopInstanceOnAllProviders('agent1')

    expect(provider('chrome').stop).toHaveBeenCalledWith('agent1')
  })

  it('does not stop a Chrome this process is not running', async () => {
    await stopInstanceOnAllProviders('agent-unknown')

    expect(provider('chrome').stop).not.toHaveBeenCalled()
  })

  it('asks every cloud provider to stop, whatever it reports as running', async () => {
    await stopInstanceOnAllProviders('agent-unknown')

    // None of them reports it as running (the mocks above).
    for (const id of CLOUD) expect(provider(id).stop, id).toHaveBeenCalledExactlyOnceWith('agent-unknown')
  })

  it('still stops the others when one cloud provider fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    provider('steel').stop.mockRejectedValue(new Error('steel is down'))

    await expect(stopInstanceOnAllProviders('agent1')).resolves.toBeUndefined()

    for (const id of ['chrome', ...CLOUD]) expect(provider(id).stop, id).toHaveBeenCalledWith('agent1')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('steel'), expect.any(Error))
    logged.mockRestore()
  })

  it('fails when Chrome cannot be stopped, so its profile is not removed under it', async () => {
    provider('chrome').stop.mockRejectedValue(new Error('chrome would not exit'))

    await expect(stopInstanceOnAllProviders('agent1')).rejects.toThrow('chrome would not exit')
  })
})
