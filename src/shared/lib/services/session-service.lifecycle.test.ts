// @libsql-must-pass
/**
 * A session's whole life against a real workspace directory and a real
 * database: created, written, renamed, starred, active, read after a
 * restart, forked, deleted. Each step checks every way the app asks about a
 * session (the list, the summary, the single read, the metadata, the
 * existence gates), because they must agree, and they are answered from two
 * places: the session index and the transcripts directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  deleteSession,
  deleteSessionsBatch,
  getSession,
  getSessionMetadata,
  getSessionSummary,
  getSessionWithMetadata,
  getSessionsByScheduledTask,
  isSessionRegistered,
  listSessions,
  listSessionsByIds,
  readSessionMetadata,
  registerSession,
  sessionExists,
  sessionIsKnown,
  updateSessionMetadata,
  updateSessionName,
} from './session-service'
import { recordSessionActivity } from './session-activity'
import { createLocalSessionStore } from '@shared/lib/agent-actor/local-session-store'
import type { SessionStore } from '@shared/lib/agent-actor/session-store'
import { perTestDatabase } from '@shared/lib/db/testing/per-test-database'

const database = perTestDatabase()
vi.mock('@shared/lib/db', () => ({ get db() { return database.db } }))

const AGENT = 'lifecycle-agent'
let dataDir: string
let store: SessionStore

const workspaceDir = () => path.join(dataDir, 'agents', AGENT, 'workspace')
const sessionsDir = () => path.join(workspaceDir(), '.claude', 'projects', '-workspace')
const transcriptFile = (sessionId: string) => path.join(sessionsDir(), `${sessionId}.jsonl`)

/** What the container's CLI does on a session's first turn, at a known time. */
function writeTranscript(sessionId: string, at: string): void {
  fs.mkdirSync(sessionsDir(), { recursive: true })
  fs.writeFileSync(transcriptFile(sessionId), '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n')
  fs.utimesSync(transcriptFile(sessionId), new Date(at), new Date(at))
}

/** Every answer the app can get about the agent's sessions, in one value. */
async function everything(from: SessionStore = store) {
  const sessions = await listSessions(from)
  const summary = await getSessionSummary(from)
  return {
    listed: sessions.map((s) => s.id),
    names: Object.fromEntries(sessions.map((s) => [s.id, s.name])),
    withTranscript: [...summary.sessionIds].sort(),
    lastActivityAt: summary.lastActivityAt,
    metadata: Object.keys(await readSessionMetadata(from)).sort(),
  }
}

beforeEach(() => {
  dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-lifecycle-')))
  vi.stubEnv('SUPERAGENT_DATA_DIR', dataDir)
  fs.mkdirSync(workspaceDir(), { recursive: true })
  store = createLocalSessionStore(AGENT)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('a session, from creation to deletion', () => {
  it('is listed from its registration, before the agent has written anything', async () => {
    await registerSession(store, 'fresh', 'Plan the launch', { createdByUserId: 'user-1' })

    expect(await everything()).toEqual({
      listed: ['fresh'],
      names: { fresh: 'Plan the launch' },
      withTranscript: [],
      lastActivityAt: null,
      metadata: ['fresh'],
    })
    const single = await getSession(store, 'fresh')
    expect(single).toMatchObject({ id: 'fresh', agentSlug: AGENT, name: 'Plan the launch', origin: 'user' })
    expect(single!.lastActivityAt).toEqual(single!.createdAt)
    expect(await sessionIsKnown(store, 'fresh')).toBe(true)
    expect(await isSessionRegistered(store, 'fresh')).toBe(true)
    // No transcript yet: the gate that needs one says no.
    expect(await sessionExists(store, 'fresh')).toBe(false)
    expect((await getSessionMetadata(store, 'fresh'))?.createdByUserId).toBe('user-1')
  })

  it('gives a session registered without a name the default one', async () => {
    await registerSession(store, 'unnamed')

    expect((await listSessions(store))[0].name).toBe('New Session')
  })

  it('takes its activity from the transcript once the agent writes it, and keeps its registration date', async () => {
    await registerSession(store, 'fresh', 'Plan the launch')
    const registeredAt = (await getSession(store, 'fresh'))!.createdAt
    writeTranscript('fresh', '2030-01-01T00:00:00.000Z')

    const [listed] = await listSessions(store)
    expect(listed).toMatchObject({ id: 'fresh', name: 'Plan the launch', lastActivityAt: new Date('2030-01-01T00:00:00.000Z') })
    expect(listed.createdAt).toEqual(registeredAt)
    // The list, the single read and the by-id read say the same.
    expect(await getSession(store, 'fresh')).toEqual(listed)
    expect(await listSessionsByIds(store, ['fresh'])).toEqual([listed])
    expect(await sessionExists(store, 'fresh')).toBe(true)
    expect((await getSessionSummary(store)).lastActivityAt).toEqual(new Date('2030-01-01T00:00:00.000Z'))
  })

  it('lists a transcript nobody registered, and lets it be named afterwards', async () => {
    writeTranscript('from-the-cli', '2030-01-01T00:00:00.000Z')

    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['from-the-cli', 'New Session']])
    expect(await isSessionRegistered(store, 'from-the-cli')).toBe(false)
    expect(await sessionIsKnown(store, 'from-the-cli')).toBe(true)

    await updateSessionName(store, 'from-the-cli', 'Named later')

    expect((await listSessions(store)).map((s) => [s.id, s.name, s.lastActivityAt])).toEqual([
      ['from-the-cli', 'Named later', new Date('2030-01-01T00:00:00.000Z')],
    ])
  })

  it('keeps a rename and a star through every later change', async () => {
    await registerSession(store, 's1', 'First name', { isScheduledExecution: true, scheduledTaskId: 'task-1', automationStatus: 'running' })
    writeTranscript('s1', '2030-01-01T00:00:00.000Z')
    await listSessions(store)

    await updateSessionName(store, 's1', 'Second name')
    await updateSessionMetadata(store, 's1', { starred: true })
    recordSessionActivity(store, 's1', new Date('2030-01-02T00:00:00.000Z'))
    await updateSessionMetadata(store, 's1', { lastUsage: { totalTokens: 1200, contextWindow: 200000 } })

    expect(await getSessionMetadata(store, 's1')).toEqual({
      name: 'Second name',
      starred: true,
      createdAt: expect.any(String),
      isScheduledExecution: true,
      scheduledTaskId: 'task-1',
      automationStatus: 'running',
      lastUsage: { totalTokens: 1200, contextWindow: 200000 },
    })
    expect(await getSession(store, 's1')).toMatchObject({ name: 'Second name', origin: 'scheduled' })
    expect((await getSessionsByScheduledTask(store, 'task-1')).map((s) => [s.id, s.name, s.lastActivityAt])).toEqual([
      ['s1', 'Second name', new Date('2030-01-02T00:00:00.000Z')],
    ])
  })

  it('moves to the top of the list on activity, without the transcript being read or statted', async () => {
    for (const [id, at] of [['older', '2030-01-01T00:00:00.000Z'], ['newer', '2030-01-02T00:00:00.000Z']]) {
      await registerSession(store, id, id)
      writeTranscript(id, at)
    }
    expect((await listSessions(store)).map((s) => s.id)).toEqual(['newer', 'older'])
    const stat = vi.spyOn(fs.promises, 'stat')

    recordSessionActivity(store, 'older', new Date('2030-01-03T00:00:00.000Z'))

    expect((await listSessions(store)).map((s) => [s.id, s.lastActivityAt])).toEqual([
      ['older', new Date('2030-01-03T00:00:00.000Z')],
      ['newer', new Date('2030-01-02T00:00:00.000Z')],
    ])
    expect(stat.mock.calls.filter(([file]) => String(file).endsWith('.jsonl'))).toEqual([])
  })

  it('reads the same after a restart as before it', async () => {
    await registerSession(store, 'written', 'Written')
    writeTranscript('written', '2030-01-01T00:00:00.000Z')
    await registerSession(store, 'pending', 'Pending')
    writeTranscript('unregistered', '2030-01-02T00:00:00.000Z')
    await updateSessionMetadata(store, 'written', { starred: true })
    await listSessions(store)
    recordSessionActivity(store, 'written', new Date('2030-01-05T00:00:00.000Z'))
    const before = { ...(await everything()), sessions: await listSessions(store) }

    const restarted = createLocalSessionStore(AGENT)

    expect({ ...(await everything(restarted)), sessions: await listSessions(restarted) }).toEqual(before)
  })

  it('forks into a second session that stands on its own', async () => {
    await registerSession(store, 'source', 'Source')
    writeTranscript('source', '2030-01-01T00:00:00.000Z')
    await listSessions(store)

    // What a fork does: the container copies the transcript, the host registers the copy.
    fs.copyFileSync(transcriptFile('source'), transcriptFile('fork'))
    fs.utimesSync(transcriptFile('fork'), new Date('2030-01-02T00:00:00.000Z'), new Date('2030-01-02T00:00:00.000Z'))
    await registerSession(store, 'fork', 'Source (fork)', { forkedFromSessionId: 'source' })

    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['fork', 'Source (fork)'], ['source', 'Source']])

    await deleteSession(store, 'source')

    expect((await everything()).listed).toEqual(['fork'])
    expect((await getSessionMetadata(store, 'fork'))?.forkedFromSessionId).toBe('source')
  })

  it('is gone from every answer once deleted, and leaves the other sessions as they were', async () => {
    for (const [id, at] of [['kept', '2030-01-01T00:00:00.000Z'], ['doomed', '2030-01-02T00:00:00.000Z']]) {
      await registerSession(store, id, id)
      writeTranscript(id, at)
    }
    await updateSessionMetadata(store, 'kept', { starred: true })
    await listSessions(store)

    expect(await deleteSession(store, 'doomed')).toBe(true)

    expect(await everything()).toEqual({
      listed: ['kept'],
      names: { kept: 'kept' },
      withTranscript: ['kept'],
      lastActivityAt: new Date('2030-01-01T00:00:00.000Z'),
      metadata: ['kept'],
    })
    expect(fs.existsSync(transcriptFile('doomed'))).toBe(false)
    expect(await getSession(store, 'doomed')).toBeNull()
    expect(await getSessionMetadata(store, 'doomed')).toBeNull()
    expect(await sessionExists(store, 'doomed')).toBe(false)
    expect(await sessionIsKnown(store, 'doomed')).toBe(false)
    expect(await isSessionRegistered(store, 'doomed')).toBe(false)
    expect(await listSessionsByIds(store, ['doomed', 'kept'])).toHaveLength(1)
    expect((await getSessionMetadata(store, 'kept'))?.starred).toBe(true)
    // And it stays gone for a store that never knew it.
    expect((await everything(createLocalSessionStore(AGENT))).listed).toEqual(['kept'])
  })

  it('deletes a registration that never got a transcript', async () => {
    await registerSession(store, 'never-started', 'Never started')

    expect(await deleteSession(store, 'never-started')).toBe(true)

    expect((await everything()).listed).toEqual([])
    expect(await sessionIsKnown(store, 'never-started')).toBe(false)
  })

  it('keeps the entry when the transcript cannot be removed, so the session is not orphaned', async () => {
    await registerSession(store, 'stuck', 'Stuck')
    writeTranscript('stuck', '2030-01-01T00:00:00.000Z')
    await listSessions(store)
    vi.spyOn(store.files, 'delete').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }))

    await expect(deleteSession(store, 'stuck')).rejects.toThrow('EACCES')

    vi.restoreAllMocks()
    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['stuck', 'Stuck']])
  })

  it('deletes a batch, keeping each session whose transcript could not be removed', async () => {
    for (const id of ['a', 'b', 'c', 'd']) {
      await registerSession(store, id, `Session ${id}`)
      writeTranscript(id, '2030-01-01T00:00:00.000Z')
    }
    await listSessions(store)
    const remove = store.files.delete.bind(store.files)
    vi.spyOn(store.files, 'delete').mockImplementation(async (file, options) => {
      if (file.endsWith('c.jsonl')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return remove(file, options)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect((await deleteSessionsBatch(store, ['a', 'c', 'd'])).sort()).toEqual(['a', 'd'])

    expect((await everything()).listed.sort()).toEqual(['b', 'c'])
    expect((await everything()).metadata).toEqual(['b', 'c'])
  })

  it('reuses a deleted session\'s id as a new session, with nothing of the old one', async () => {
    await registerSession(store, 'reused', 'Old life')
    writeTranscript('reused', '2030-01-01T00:00:00.000Z')
    await updateSessionMetadata(store, 'reused', { starred: true })
    await listSessions(store)
    recordSessionActivity(store, 'reused', new Date('2030-06-01T00:00:00.000Z'))
    await deleteSession(store, 'reused')

    await registerSession(store, 'reused', 'New life')
    writeTranscript('reused', '2030-02-01T00:00:00.000Z')

    expect((await listSessions(store)).map((s) => [s.id, s.name, s.lastActivityAt])).toEqual([
      ['reused', 'New life', new Date('2030-02-01T00:00:00.000Z')],
    ])
    expect((await getSessionMetadata(store, 'reused'))?.starred).toBeUndefined()
  })
})

describe('a session-metadata.json left in the workspace', () => {
  const legacyFile = () => path.join(workspaceDir(), 'session-metadata.json')

  it('is taken into the index before the index is first used, and removed', async () => {
    writeTranscript('s1', '2026-11-01T09:00:00Z')
    fs.writeFileSync(legacyFile(), JSON.stringify({ s1: { name: 'Pricing decision', createdAt: '2026-11-01T08:00:00Z' } }))

    expect((await listSessions(store)).map((s) => [s.id, s.name])).toEqual([['s1', 'Pricing decision']])
    expect(fs.existsSync(legacyFile())).toBe(false)
  })

  it('keeps what the file says about a session renamed before anything was read', async () => {
    writeTranscript('s1', '2026-11-01T09:00:00Z')
    fs.writeFileSync(legacyFile(), JSON.stringify({
      s1: { name: 'Old name', createdAt: '2026-11-01T08:00:00Z', scheduledTaskId: 'task-1', isScheduledExecution: true },
    }))

    await updateSessionName(store, 's1', 'New name')

    expect(await getSessionMetadata(store, 's1')).toMatchObject({ name: 'New name', scheduledTaskId: 'task-1' })
    expect((await getSessionsByScheduledTask(store, 'task-1')).map((s) => s.id)).toEqual(['s1'])
  })

  it('sets a file that does not fit aside once, however often taking it in stops before removing it', async () => {
    fs.writeFileSync(legacyFile(), JSON.stringify({ kept: { name: 'Kept', createdAt: new Date().toISOString() }, bad: { name: 42 } }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(store.files, 'delete').mockRejectedValueOnce(new Error('EACCES: permission denied'))

    await listSessions(store)
    expect(fs.existsSync(legacyFile())).toBe(true)

    // The next actor, after a restart, takes the same file in again.
    const restarted = createLocalSessionStore(AGENT)
    expect((await listSessions(restarted)).map((s) => s.name)).toEqual(['Kept'])
    const left = fs.readdirSync(workspaceDir()).filter((name) => name.startsWith('session-metadata'))
    expect(left).toEqual([expect.stringMatching(/^session-metadata\.corrupt-[0-9a-f]{16}\.json$/)])
  })
})

describe('the time a single read answers', () => {
  it('is the listing\'s, after a transcript write the host did not see', async () => {
    writeTranscript('s1', '2026-11-01T09:00:00Z')
    expect((await listSessions(store))[0].lastActivityAt).toEqual(new Date('2026-11-01T09:00:00Z'))
    // A resume rewrote the transcript while the host was down.
    fs.utimesSync(transcriptFile('s1'), new Date('2026-11-01T10:00:00Z'), new Date('2026-11-01T10:00:00Z'))

    expect((await getSession(store, 's1'))?.lastActivityAt).toEqual(new Date('2026-11-01T09:00:00Z'))
    expect((await listSessionsByIds(store, ['s1']))[0].lastActivityAt).toEqual(new Date('2026-11-01T09:00:00Z'))
    expect((await listSessions(store))[0].lastActivityAt).toEqual(new Date('2026-11-01T09:00:00Z'))
  })
})

describe('a session read with its metadata', () => {
  /** The statements sent to the driver from here on: every one is prepared by the drizzle session. */
  function statements(): () => string[] {
    const prepare = vi.spyOn((database.db as unknown as { session: { prepareQuery(query: { sql: string }): unknown } }).session, 'prepareQuery')
    return () => prepare.mock.calls.map(([query]) => query.sql)
  }

  /** What the single-session route read before: the session, and its metadata out of every session's. */
  async function readSeparately(sessionId: string) {
    const all = await readSessionMetadata(store)
    const metadata = Object.hasOwn(all, sessionId) ? all[sessionId] : null
    const session = await getSession(store, sessionId, { metadata })
    return session && { session, metadata }
  }

  it('answers the session and its metadata as the two reads did, for every kind of session', async () => {
    writeTranscript('written', '2026-11-01T09:00:00Z')
    await registerSession(store, 'written', 'Written', { model: 'claude-sonnet-5', forkedFromSessionId: 'source' })
    writeTranscript('unregistered', '2026-11-01T10:00:00Z')
    await registerSession(store, 'fresh', 'Fresh', { invokedByAgentSlug: 'caller' })
    await store.index.update('orphaned', () => ({ name: 'Orphaned', createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() }))
    await store.index.update('starred-only', () => ({ starred: true }))
    // Seen by a listing, as the app's sessions are by the time one is opened.
    await listSessions(store)

    for (const sessionId of ['written', 'unregistered', 'fresh', 'orphaned', 'starred-only', 'no-such-session']) {
      const together = await getSessionWithMetadata(store, sessionId)
      expect(together, sessionId).toEqual(await readSeparately(sessionId))
      expect(together?.session ?? null, sessionId).toEqual(await getSession(store, sessionId))
      if (together) expect(together.metadata, sessionId).toEqual(await getSessionMetadata(store, sessionId))
    }
    expect(await getSessionWithMetadata(store, 'written')).toMatchObject({
      session: { id: 'written', name: 'Written', lastActivityAt: new Date('2026-11-01T09:00:00Z') },
      metadata: { name: 'Written', model: 'claude-sonnet-5', forkedFromSessionId: 'source' },
    })
    // A transcript nobody registered is a session the app keeps nothing about.
    expect(await getSessionWithMetadata(store, 'unregistered')).toMatchObject({ session: { id: 'unregistered', name: 'New Session' }, metadata: null })
    expect(await getSessionWithMetadata(store, 'fresh')).toMatchObject({ session: { name: 'Fresh' }, metadata: { invokedByAgentSlug: 'caller' } })
    expect(await getSessionWithMetadata(store, 'orphaned')).toBeNull()
    expect(await getSessionWithMetadata(store, 'starred-only')).toBeNull()
    expect(await getSessionWithMetadata(store, 'no-such-session')).toBeNull()
  })

  it('carries activity recorded since the last listing', async () => {
    writeTranscript('s1', '2026-11-01T09:00:00Z')
    await registerSession(store, 's1', 'One')
    await listSessions(store)

    recordSessionActivity(store, 's1', new Date('2026-11-01T11:00:00Z'))

    const together = await getSessionWithMetadata(store, 's1')
    expect(together?.session.lastActivityAt).toEqual(new Date('2026-11-01T11:00:00Z'))
    expect(together?.metadata).toMatchObject({ name: 'One' })
  })

  it('does not follow a link to another agent\'s transcript', async () => {
    const other = path.join(dataDir, 'agents', 'other-agent', 'workspace', '.claude', 'projects', '-workspace')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'theirs.jsonl'), '{}\n')
    fs.mkdirSync(sessionsDir(), { recursive: true })
    fs.symlinkSync(path.join(other, 'theirs.jsonl'), transcriptFile('linked'))
    await registerSession(store, 'linked', 'Linked')

    expect(await getSessionWithMetadata(store, 'linked')).toBeNull()
    expect(await getSession(store, 'linked')).toBeNull()
  })

  it.each([1, 50, 1500])('reads one row of the index among %i sessions, where the two reads read them all', async (count) => {
    fs.mkdirSync(sessionsDir(), { recursive: true })
    for (let i = 0; i < count; i++) fs.writeFileSync(transcriptFile(`session-${i}`), '{}\n')
    await store.index.fill(Array.from({ length: count }, (_, i) => ({
      sessionId: `session-${i}`,
      meta: { name: `Session ${i}`, createdAt: '2030-01-01T00:00:00.000Z' },
      transcript: null,
    })))
    expect(await listSessions(store)).toHaveLength(count)
    const target = `session-${count - 1}`
    // A write to any of the agent's sessions (a turn's activity, a rename)
    // makes the index forget what it listed: the state a session is opened in
    // while another one is running.
    await updateSessionMetadata(store, 'another-session', { starred: true })
    const sent = statements()
    const selected = vi.spyOn(database.db, 'select')

    const together = await getSessionWithMetadata(store, target)

    expect(together).toMatchObject({ session: { id: target, name: `Session ${count - 1}` }, metadata: { name: `Session ${count - 1}` } })
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatch(/"session_id" = \?/)
    expect(selected).toHaveBeenCalledTimes(1)

    // The counter sees what this replaced: every row of the agent, then the session's own.
    await updateSessionMetadata(store, 'another-session', { starred: false })
    const before = sent().length
    expect(await readSeparately(target)).toEqual(together)
    const replaced = sent().slice(before)
    expect(replaced).toHaveLength(2)
    expect(replaced[0]).not.toMatch(/"session_id" = \?/)
  })

  it('reads one row while the index still holds its last listing, too', async () => {
    writeTranscript('s1', '2026-11-01T09:00:00Z')
    await registerSession(store, 's1', 'One')
    await listSessions(store)
    const sent = statements()

    expect(await getSessionWithMetadata(store, 's1')).toMatchObject({ session: { id: 's1' }, metadata: { name: 'One' } })

    expect(sent()).toHaveLength(1)
  })
})

describe('many sessions', () => {
  const COUNT = 1500

  it('lists, renames and deletes one among many without touching the others\' files', async () => {
    fs.mkdirSync(sessionsDir(), { recursive: true })
    for (let i = 0; i < COUNT; i++) {
      fs.writeFileSync(transcriptFile(`session-${i}`), '{}\n')
    }
    // Long unchanged, as an agent's directory mostly is: one listing settles it.
    const anHourAgo = new Date(Date.now() - 3_600_000)
    fs.utimesSync(sessionsDir(), anHourAgo, anHourAgo)
    await store.index.fill(Array.from({ length: COUNT }, (_, i) => ({
      sessionId: `session-${i}`,
      meta: { name: `Session ${i}`, createdAt: '2030-01-01T00:00:00.000Z' },
      transcript: null,
    })))
    // The first listing sees every transcript, once.
    expect(await listSessions(store)).toHaveLength(COUNT)

    const stat = vi.spyOn(fs.promises, 'stat')
    const readdir = vi.spyOn(fs.promises, 'readdir')
    const writes = (['writeFile', 'rename', 'open', 'appendFile'] as const).map((method) => vi.spyOn(fs.promises, method))
    const updates = vi.spyOn(database.db, 'update')

    expect(await listSessions(store, { limit: 10 })).toHaveLength(10)
    await updateSessionName(store, 'session-700', 'Renamed')
    await updateSessionMetadata(store, 'session-700', { starred: true })
    expect(await getSessionMetadata(store, 'session-700')).toMatchObject({ name: 'Renamed', starred: true })

    // One stat of the directory for the listing; nothing else on the volume.
    expect(stat.mock.calls.map(([file]) => String(file))).toEqual([sessionsDir()])
    expect(readdir).not.toHaveBeenCalled()
    for (const write of writes) expect(write).not.toHaveBeenCalled()
    // Each change is one row.
    expect(updates).toHaveBeenCalledTimes(2)

    await deleteSession(store, 'session-700')
    const after = await listSessions(store)
    expect(after).toHaveLength(COUNT - 1)
    expect(after.some((s) => s.id === 'session-700')).toBe(false)
  })
})
