/**
 * Reading a Browserbase session's download, against a fake Downloads API that
 * answers as the real one did (2026-11-27): the listing names each download by
 * its CDP guid with `application/octet-stream` as its type, and the file is
 * read by its download id with `Accept: application/octet-stream`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertBrowserbaseSessionOn, listBrowserbaseDownloads, readBrowserbaseDownload } from './browserbase-downloads'
import { DownloadTooLargeError, DownloadsUnsupportedError, MAX_BROWSER_DOWNLOAD_BYTES, SessionNotOwnedError, findStoredDownload, storedNameMatches } from './downloads'

const API = { base: 'https://api.browserbase.com/v1', headers: { 'X-BB-API-Key': 'bb-test' } }

interface Stored { id: string; sessionId: string; filename: string; size: number; bytes: Buffer }
let stored: Stored[]
let calls: Array<{ url: string; accept: string | undefined }>
/** Sessions by id: the context each was created on (kept after it ends). */
let sessions: Map<string, { contextId: string | null; status: string }>
/** Answer listings with every session's files, as a Browserbase ignoring `sessionId` would. */
let ignoreSessionFilter: boolean

beforeEach(() => {
  stored = []
  calls = []
  ignoreSessionFilter = false
  sessions = new Map([['sess-1', { contextId: 'ctx-a', status: 'COMPLETED' }], ['sess-2', { contextId: 'ctx-b', status: 'RUNNING' }]])
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, accept: headers.Accept })
    if (headers['X-BB-API-Key'] !== 'bb-test') return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const { pathname, searchParams } = new URL(url)
    const session = pathname.match(/^\/v1\/sessions\/([^/]+)$/)
    if (session) {
      const found = sessions.get(session[1])
      return found ? Response.json({ id: session[1], projectId: 'p', ...found }) : Response.json({ error: 'not found' }, { status: 404 })
    }
    if (pathname === '/v1/downloads') {
      const limit = Number(searchParams.get('limit'))
      const offset = Number(searchParams.get('offset'))
      const mine = stored.filter((d) => ignoreSessionFilter || d.sessionId === searchParams.get('sessionId'))
      const page = mine.slice(offset, offset + limit)
      return Response.json({
        downloads: page.map(({ id, sessionId, filename, size }) => ({ id, sessionId, filename, size, mimeType: 'application/octet-stream', checksum: 'x', createdAt: '2026-11-27T20:07:12Z' })),
        total: mine.length, limit, offset,
      })
    }
    const read = pathname.match(/^\/v1\/downloads\/([^/]+)$/)
    const file = read && stored.find((d) => d.id === read[1])
    if (file && headers.Accept === 'application/octet-stream') return new Response(new Uint8Array(file.bytes), { status: 200 })
    return Response.json({ error: 'not found' }, { status: 404 })
  }))
})
afterEach(() => vi.unstubAllGlobals())

function store(filename: string, content: string, sessionId = 'sess-1') {
  const bytes = Buffer.from(content)
  stored.push({ id: `dl-${stored.length + 1}`, sessionId, filename, size: bytes.length, bytes })
}

describe('storedNameMatches', () => {
  const download = { guid: '5409f94c-60b3-4e82-95c7-3aee3331b123' }
  it("takes the guid and the archive's guid-timestamp; never a file still being written", () => {
    expect(storedNameMatches(download.guid, download)).toBe(true)
    expect(storedNameMatches(`${download.guid}-1795810032253`, download)).toBe(true)
    expect(storedNameMatches(`/files/${download.guid}`, download)).toBe(true)
    expect(storedNameMatches(`${download.guid}.crdownload`, download)).toBe(false)
    expect(storedNameMatches(`${download.guid}-x`, download)).toBe(false)
    expect(storedNameMatches('other.csv', download)).toBe(false)
  })
  it('takes a name a listing gave as it is', () => {
    expect(findStoredDownload(['/files/a.csv', '/files/notes.txt'], (f) => f, { guid: 'notes.txt' })).toBe('/files/notes.txt')
  })
})

describe('assertBrowserbaseSessionOn', () => {
  it("passes a session on the agent's context, also once it has ended", async () => {
    await expect(assertBrowserbaseSessionOn(API, 'sess-1', 'ctx-a')).resolves.toBeUndefined()
  })
  it("refuses another context's session, a session Browserbase does not know, and any session for an agent with no context", async () => {
    await expect(assertBrowserbaseSessionOn(API, 'sess-2', 'ctx-a')).rejects.toBeInstanceOf(SessionNotOwnedError)
    await expect(assertBrowserbaseSessionOn(API, 'sess-9', 'ctx-a')).rejects.toBeInstanceOf(SessionNotOwnedError)
    await expect(assertBrowserbaseSessionOn(API, 'sess-1', null)).rejects.toBeInstanceOf(SessionNotOwnedError)
    sessions.set('sess-3', { contextId: null, status: 'RUNNING' })
    await expect(assertBrowserbaseSessionOn(API, 'sess-3', 'ctx-a')).rejects.toBeInstanceOf(SessionNotOwnedError)
  })
})

describe('listBrowserbaseDownloads', () => {
  it("lists only the session's files, by the name Browserbase stores them under", async () => {
    store('guid-1', 'abc')
    store('guid-2', 'other session', 'sess-2')
    expect(await listBrowserbaseDownloads(API, 'sess-1')).toEqual([{ name: 'guid-1', size: 3 }])
  })

  it("keeps only the session's own when Browserbase answers with others' (the project is shared)", async () => {
    store('guid-1', 'mine')
    store('guid-2', 'another tenant', 'sess-2')
    ignoreSessionFilter = true
    expect(await listBrowserbaseDownloads(API, 'sess-1')).toEqual([{ name: 'guid-1', size: 4 }])
    expect(await readBrowserbaseDownload(API, 'sess-1', { guid: 'guid-2' })).toBeNull()
  })
})

describe('readBrowserbaseDownload', () => {
  it('finds the session\'s download by its guid and reads its bytes', async () => {
    store('guid-other', 'nope')
    store('guid-1', 'keyword,volume\n')
    store('guid-1', 'another session', 'sess-2')
    const bytes = await readBrowserbaseDownload(API, 'sess-1', { guid: 'guid-1' })
    expect(bytes?.toString()).toBe('keyword,volume\n')
    expect(calls[0].url).toBe('https://api.browserbase.com/v1/downloads?sessionId=sess-1&limit=100&offset=0')
    expect(calls[1]).toEqual({ url: 'https://api.browserbase.com/v1/downloads/dl-2', accept: 'application/octet-stream' })
  })

  it('answers null while Browserbase has not listed it yet', async () => {
    expect(await readBrowserbaseDownload(API, 'sess-1', { guid: 'guid-1' })).toBeNull()
  })

  it('reads past the first page', async () => {
    for (let i = 0; i < 100; i++) store(`guid-${i}`, 'x')
    store('guid-last', 'last')
    expect((await readBrowserbaseDownload(API, 'sess-1', { guid: 'guid-last' }))?.toString()).toBe('last')
  })

  it('refuses a file over the limit before reading it', async () => {
    stored.push({ id: 'dl-big', sessionId: 'sess-1', filename: 'guid-big', size: MAX_BROWSER_DOWNLOAD_BYTES + 1, bytes: Buffer.alloc(0) })
    await expect(readBrowserbaseDownload(API, 'sess-1', { guid: 'guid-big' })).rejects.toBeInstanceOf(DownloadTooLargeError)
    expect(calls).toHaveLength(1)
  })

  it('takes a 404 on the listing as no Downloads API when told to (the platform proxy), and as an error otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Not found' }, { status: 404 })))
    await expect(readBrowserbaseDownload({ ...API, unsupportedOn404: 'The proxy does not serve downloads' }, 'sess-1', { guid: 'g' }))
      .rejects.toBeInstanceOf(DownloadsUnsupportedError)
    await expect(readBrowserbaseDownload(API, 'sess-1', { guid: 'g' })).rejects.toThrow('Browserbase answered 404')
  })
})
