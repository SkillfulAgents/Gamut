/**
 * The shared record of an agent's live browser session, over the AppState the
 * test setup installs. Each call stands in for a process that serves the
 * tenant: they share nothing but the record.
 */
import { describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'
import { defineLiveSessions, openLiveSession, type LiveSessions, type RecordedSessionState, type SessionBrowser } from './live-session'
import { browserbaseSessionState } from './browserbase-session-status'

const sessions = defineLiveSessions('browserbase')

/** A provider account whose sessions the test starts, ends and breaks. */
function fakeBrowser() {
  const state = new Map<string, 'running' | 'ended' | 'unknown'>()
  const log: string[] = []
  let made = 0
  const browser: SessionBrowser<string> = {
    async connect(sessionId): Promise<RecordedSessionState<string>> {
      log.push(`connect ${sessionId}`)
      const found = state.get(sessionId) ?? 'unknown'
      return found === 'running' ? { state: 'running', connection: `cdp:${sessionId}` } : { state: found }
    },
    async create() {
      const sessionId = `sess-${++made}`
      state.set(sessionId, 'running')
      log.push(`create ${sessionId}`)
      return { sessionId, connection: `cdp:${sessionId}` }
    },
    async release(sessionId) {
      log.push(`release ${sessionId}`)
      state.set(sessionId, 'ended')
    },
  }
  const running = () => [...state].filter(([, s]) => s === 'running').map(([id]) => id)
  return { browser, state, log, running }
}

describe('the recorded session', () => {
  it('is read back by any process, and taken by one stop only', async () => {
    expect(await sessions.read('agent-a')).toBeNull()
    expect(await sessions.record('agent-a', 'sess-1', null)).toEqual({ recorded: true })
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-1')

    const taken = await Promise.all([sessions.take('agent-a'), sessions.take('agent-a'), sessions.take('agent-a')])
    expect(taken.filter(Boolean)).toEqual(['sess-1'])
    expect(await sessions.read('agent-a')).toBeNull()
  })

  it('is replaced only by the process that read it last', async () => {
    await sessions.record('agent-a', 'sess-1', null)
    const read = await sessions.read('agent-a')

    expect(await sessions.record('agent-a', 'sess-2', read)).toEqual({ recorded: true })
    // A second process that read the same record lost the race: it is told what is there now.
    const late = await sessions.record('agent-a', 'sess-3', read)
    expect(late.recorded).toBe(false)
    expect(!late.recorded && late.current?.sessionId).toBe('sess-2')
    // And a process that saw none cannot write over one.
    const blind = await sessions.record('agent-a', 'sess-4', null)
    expect(!blind.recorded && blind.current?.sessionId).toBe('sess-2')
  })

  it('never matches a record taken and written again', async () => {
    await sessions.record('agent-a', 'sess-1', null)
    const read = await sessions.read('agent-a')
    await sessions.take('agent-a')
    await sessions.record('agent-a', 'sess-2', null)

    const stale = await sessions.record('agent-a', 'sess-3', read)
    expect(!stale.recorded && stale.current?.sessionId).toBe('sess-2')
  })

  it('keeps each agent and each provider apart', async () => {
    const platform = defineLiveSessions('platform')
    await sessions.record('agent-a', 'bb-a', null)
    await sessions.record('agent-b', 'bb-b', null)
    await platform.record('agent-a', 'pf-a', null)

    expect((await sessions.read('agent-a'))?.sessionId).toBe('bb-a')
    expect((await sessions.read('agent-b'))?.sessionId).toBe('bb-b')
    expect((await platform.read('agent-a'))?.sessionId).toBe('pf-a')
    expect(await platform.take('agent-b')).toBeNull()
  })

  it('is taken by a process letting go of its own session only while it still names that one', async () => {
    await sessions.record('agent-a', 'sess-2', null)

    expect(await sessions.take('agent-a', 'sess-1')).toBeNull()
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-2')
    expect(await sessions.take('agent-b', 'sess-2')).toBeNull()

    expect(await sessions.take('agent-a', 'sess-2')).toBe('sess-2')
    expect(await sessions.read('agent-a')).toBeNull()
    expect(await sessions.take('agent-a', 'sess-2')).toBeNull()
  })

  it('is not taken for a session that was replaced between the look and the take', async () => {
    await sessions.record('agent-a', 'sess-1', null)
    const get = appState().get.bind(appState())
    // Another process replaces the record right after this one read it.
    vi.spyOn(appState(), 'get').mockImplementationOnce(async (key) => {
      const entry = await get(key)
      await sessions.take('agent-a')
      await sessions.record('agent-a', 'sess-2', null)
      return entry
    })

    expect(await sessions.take('agent-a', 'sess-1')).toBeNull()
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-2')
  })

  it('is restored after a failed release, unless another session was recorded since', async () => {
    await sessions.restore('agent-a', 'sess-1')
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-1')

    await sessions.restore('agent-a', 'sess-0')
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-1')
  })

  it('does not expire', async () => {
    vi.useFakeTimers()
    try {
      await sessions.record('agent-a', 'sess-1', null)
      vi.setSystemTime(Date.now() + 400 * 24 * 60 * 60 * 1000)
      expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-1')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('openLiveSession', () => {
  it('creates and records a session when the agent has none', async () => {
    const { browser, log } = fakeBrowser()

    expect(await openLiveSession(sessions, 'agent-a', browser)).toEqual({ sessionId: 'sess-1', connection: 'cdp:sess-1', reused: false })
    expect(log).toEqual(['create sess-1'])
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-1')
  })

  it('uses the recorded session while it runs, without creating one', async () => {
    const { browser, log } = fakeBrowser()
    await openLiveSession(sessions, 'agent-a', browser)
    log.length = 0

    expect(await openLiveSession(sessions, 'agent-a', browser)).toEqual({ sessionId: 'sess-1', connection: 'cdp:sess-1', reused: true })
    expect(log).toEqual(['connect sess-1'])
  })

  it('replaces a session that ended, and does not release it again', async () => {
    const { browser, state, log } = fakeBrowser()
    await openLiveSession(sessions, 'agent-a', browser)
    state.set('sess-1', 'ended')
    log.length = 0

    expect(await openLiveSession(sessions, 'agent-a', browser)).toMatchObject({ sessionId: 'sess-2', reused: false })
    expect(log).toEqual(['connect sess-1', 'create sess-2'])
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-2')
  })

  it('replaces a session it cannot reach and releases it, since it may still run', async () => {
    const { browser, state, log, running } = fakeBrowser()
    await openLiveSession(sessions, 'agent-a', browser)
    state.set('sess-1', 'unknown')
    log.length = 0

    expect(await openLiveSession(sessions, 'agent-a', browser)).toMatchObject({ sessionId: 'sess-2', reused: false })
    // Released only once the new one is recorded: until then it was still the agent's browser.
    expect(log).toEqual(['connect sess-1', 'create sess-2', 'release sess-1'])
    expect(running()).toEqual(['sess-2'])
  })

  it('leaves one session when several processes launch at once', async () => {
    const { browser, log, running } = fakeBrowser()

    const opened = await Promise.all(Array.from({ length: 5 }, () => openLiveSession(sessions, 'agent-a', browser)))

    const recorded = (await sessions.read('agent-a'))?.sessionId
    expect(running()).toEqual([recorded])
    expect(new Set(opened.map((o) => o.sessionId))).toEqual(new Set([recorded]))
    expect(new Set(opened.map((o) => o.connection))).toEqual(new Set([`cdp:${recorded}`]))
    expect(opened.filter((o) => !o.reused)).toHaveLength(1)
    // Every session a loser created was released.
    const created = log.filter((line) => line.startsWith('create ')).map((line) => line.slice(7))
    const released = log.filter((line) => line.startsWith('release ')).map((line) => line.slice(8))
    expect(created.filter((id) => id !== recorded).sort()).toEqual(released.sort())
  })

  it('leaves one session when several processes replace an ended one at once', async () => {
    const { browser, state, running } = fakeBrowser()
    await openLiveSession(sessions, 'agent-a', browser)
    state.set('sess-1', 'ended')

    const opened = await Promise.all(Array.from({ length: 4 }, () => openLiveSession(sessions, 'agent-a', browser)))

    const recorded = (await sessions.read('agent-a'))?.sessionId
    expect(recorded).not.toBe('sess-1')
    expect(running()).toEqual([recorded])
    expect(new Set(opened.map((o) => o.sessionId))).toEqual(new Set([recorded]))
  })

  it.each(['ended', 'unknown'] as const)('records the session it made when a stop takes a record of an %s session mid-launch', async (recordedState) => {
    const { browser, state, log, running } = fakeBrowser()
    await openLiveSession(sessions, 'agent-a', browser)
    state.set('sess-1', recordedState)
    log.length = 0
    // A stop in another process lands between this launch's read and its write.
    const create = browser.create.bind(browser)
    browser.create = async () => {
      browser.create = create
      await sessions.take('agent-a')
      return create()
    }

    const opened = await openLiveSession(sessions, 'agent-a', browser)

    // No second session, and sess-1 is left to the stop that took it.
    expect(log).toEqual(['connect sess-1', 'create sess-2'])
    expect(opened).toMatchObject({ sessionId: 'sess-2', reused: false })
    expect((await sessions.read('agent-a'))?.sessionId).toBe('sess-2')
    expect(running()).toEqual(['sess-2'])
  })

  it('releases the session it created when it cannot be recorded, and fails', async () => {
    const { browser, running } = fakeBrowser()
    vi.spyOn(appState(), 'compareAndSet').mockRejectedValueOnce(new Error('AppState is unreachable'))

    await expect(openLiveSession(sessions, 'agent-a', browser)).rejects.toThrow('AppState is unreachable')

    expect(running()).toEqual([])
    expect(await sessions.read('agent-a')).toBeNull()
  })

  it('fails with the record\'s error, not the release\'s, when both fail', async () => {
    const { browser } = fakeBrowser()
    vi.spyOn(appState(), 'compareAndSet').mockRejectedValueOnce(new Error('AppState is unreachable'))
    browser.release = async () => {
      throw new Error('the release failed too')
    }

    await expect(openLiveSession(sessions, 'agent-a', browser)).rejects.toThrow('AppState is unreachable')
  })

  it('creates nothing when the record cannot be read', async () => {
    const { browser, log } = fakeBrowser()
    vi.spyOn(appState(), 'get').mockRejectedValueOnce(new Error('AppState is unreachable'))

    await expect(openLiveSession(sessions, 'agent-a', browser)).rejects.toThrow('AppState is unreachable')
    expect(log).toEqual([])
  })

  it('records nothing when the session cannot be created', async () => {
    const { browser } = fakeBrowser()
    browser.create = async () => {
      throw new Error('Failed to create Browserbase session: 500')
    }

    await expect(openLiveSession(sessions, 'agent-a', browser)).rejects.toThrow('Failed to create')
    expect(await sessions.read('agent-a')).toBeNull()
  })

  it('gives up, with nothing left running, when the record never stops changing', async () => {
    const { browser, running } = fakeBrowser()
    let writes = 0
    // Every write loses to another process, whose own session has already ended by the next look.
    const contested: LiveSessions = {
      ...sessions,
      read: async () => null,
      record: async () => ({ recorded: false, current: { sessionId: `other-${++writes}`, revision: `r${writes}` as never } }),
    }
    browser.connect = async () => ({ state: 'ended' })

    await expect(openLiveSession(contested, 'agent-a', browser)).rejects.toThrow('kept changing')
    expect(writes).toBe(4)
    expect(running()).toEqual([])
  })
})

describe('browserbaseSessionState', () => {
  it('knows the running status and the final ones, and nothing else', () => {
    expect(browserbaseSessionState('RUNNING')).toBe('running')
    for (const status of ['COMPLETED', 'ERROR', 'TIMED_OUT']) expect(browserbaseSessionState(status)).toBe('ended')
    for (const status of ['PENDING', 'running', '', 'SOMETHING_NEW']) expect(browserbaseSessionState(status)).toBe('unknown')
  })
})
