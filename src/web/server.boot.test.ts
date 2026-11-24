import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The web entry's boot order: error reporting first, then the database (and
// the tenant identity that lives in it), then AppState, then the agents, then task dispatch, then the bind. A failed open is the first thing
// that can end the process, and its fatal report must have a provider to reach
// and time to send.
const calls: string[] = []
const openDatabase = vi.fn(async () => {
  calls.push('openDatabase')
})
const initErrorReporting = vi.fn(() => {
  calls.push('initErrorReporting')
})
const flushErrorReporting = vi.fn(async () => {
  calls.push('flushErrorReporting')
  return true
})
const attachErrorReportingIdentity = vi.fn(async () => {
  calls.push('attachErrorReportingIdentity')
})
const initializeLocalAppState = vi.fn(async () => {
  calls.push('initializeLocalAppState')
})
// The entry says which actor its agents run as: the one whose container and files this process manages.
const initializeAgentRegistry = vi.fn((_createActor: (slug: string) => object) => {
  calls.push('initializeAgentRegistry')
})
class LocalAgentActor {
  constructor(readonly slug: string, readonly parts: object) {}
}
const containerHost = {}
const localHostPort = {}
const initializeBackgroundWork = vi.fn(async (_manager: object) => {
  calls.push('initializeBackgroundWork')
})
const registerBackgroundWork = vi.fn(() => {
  calls.push('registerBackgroundWork')
})
const bindServerWithRetry = vi.fn(async () => {
  calls.push('bind')
  return { server: { close: vi.fn() }, port: 47891 }
})
const afterBindInitialize = vi.fn(async () => {
  calls.push('afterBindInitialize')
})

vi.mock('../api', async () => {
  const { Hono } = await import('hono')
  return { default: new Hono() }
})
vi.mock('@shared/lib/db', () => ({ openDatabase }))
vi.mock('@shared/lib/error-reporting', () => ({ initErrorReporting, flushErrorReporting, attachErrorReportingIdentity }))
vi.mock('@shared/lib/error-reporting/sentry-provider', () => ({ createServerProvider: () => null }))
vi.mock('@shared/lib/app-state', () => ({ initializeLocalAppState }))
vi.mock('@shared/lib/agent-actor', () => ({ containerHost, initializeAgentRegistry }))
vi.mock('@shared/lib/agent-actor/local-agent-actor', () => ({ LocalAgentActor }))
vi.mock('@shared/lib/host/local-host-port', () => ({ localHostPort }))
vi.mock('@shared/lib/background-work', () => ({ initializeBackgroundWork }))
vi.mock('@shared/lib/server-bind', () => ({ bindServerWithRetry }))
vi.mock('@shared/lib/startup', () => ({
  afterBindInitialize,
  registerBackgroundWork,
  setupServerHandlers: vi.fn(),
  shutdownServices: vi.fn(),
}))
vi.mock('@shared/lib/boot-timing', () => ({ markBoot: vi.fn() }))

async function boot() {
  vi.resetModules()
  await import('./server')
  // start() is fire-and-forget at module load; let its chain settle.
  await vi.waitFor(() => expect(calls.includes('afterBindInitialize') || calls.includes('exit')).toBe(true))
}

let exitSpy: ReturnType<typeof vi.spyOn>
let previousNodeEnv: string | undefined

beforeEach(() => {
  calls.length = 0
  previousNodeEnv = process.env.NODE_ENV
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    calls.push(`exit:${code}`)
    calls.push('exit')
  }) as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
  vi.restoreAllMocks()
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('web server boot order', () => {
  it('initialises error reporting before opening the database, then AppState, then the agents, then task dispatch, then binds', async () => {
    process.env.NODE_ENV = 'production'
    await boot()
    expect(calls).toEqual([
      'initErrorReporting',
      'openDatabase',
      'attachErrorReportingIdentity',
      'initializeLocalAppState',
      'initializeAgentRegistry',
      'initializeBackgroundWork',
      'registerBackgroundWork',
      'bind',
      'afterBindInitialize',
    ])
  })

  it('runs each agent as a local actor, given this machine\'s container layer and the local host port', async () => {
    process.env.NODE_ENV = 'test'
    await boot()
    const actor = initializeAgentRegistry.mock.lastCall?.[0]('agent-1') as LocalAgentActor
    expect(actor).toBeInstanceOf(LocalAgentActor)
    expect(actor.slug).toBe('agent-1')
    const parts = actor.parts as { containers: object; host: object }
    expect(parts.containers).toBe(containerHost)
    expect(parts.host).toBe(localHostPort)
  })

  it('picks the local task manager itself', async () => {
    process.env.NODE_ENV = 'test'
    await boot()
    expect(initializeBackgroundWork.mock.lastCall?.[0]?.constructor.name).toBe('LocalTaskManager')
  })

  it('skips error reporting outside production, as afterBindInitialize does', async () => {
    process.env.NODE_ENV = 'test'
    await boot()
    expect(calls).toEqual(['openDatabase', 'attachErrorReportingIdentity', 'initializeLocalAppState', 'initializeAgentRegistry', 'initializeBackgroundWork', 'registerBackgroundWork', 'bind', 'afterBindInitialize'])
  })

  it('flushes error reporting before exiting when the database fails to open', async () => {
    process.env.NODE_ENV = 'production'
    openDatabase.mockImplementationOnce(async () => {
      calls.push('openDatabase')
      throw new Error('database disk image is malformed')
    })
    await boot()
    expect(calls).toEqual(['initErrorReporting', 'openDatabase', 'flushErrorReporting', 'exit:1', 'exit'])
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
