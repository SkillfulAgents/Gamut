/**
 * The download watcher against a fake browser connection that sends the
 * events a real one does (measured on Browserbase and Steel, 2026-11-27): a
 * download begins (`Browser.downloadWillBegin`, with the page's name and a
 * guid), reports progress, and completes or is canceled. The provider stores
 * it under its guid whether anyone listens or not, and its copy appears a
 * moment after completion.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdpConnection, CdpEvent } from './login-cdp'
import {
  CLOUD_DOWNLOAD_BEHAVIOR,
  DownloadWatcher,
  formatDownloadReports,
  hostDownloads,
  type HostFileAnswer,
  type HostListAnswer,
} from './download-watcher'

class FakeConnection {
  sent: Array<{ method: string; params: unknown }> = []
  listeners = new Set<(event: CdpEvent) => void>()
  isClosed = false
  async send(method: string, params: Record<string, unknown> = {}) {
    if (this.isClosed) throw new Error(`${method}: CDP connection closed`)
    this.sent.push({ method, params })
    return {}
  }
  onEvent(listener: (event: CdpEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close() { this.isClosed = true }
  emit(method: string, params: Record<string, unknown>) {
    if (this.isClosed) return
    for (const listener of this.listeners) listener({ method, params, sessionId: undefined })
  }
}

/** The cloud browser: what the provider stores, and the events a connection hears. */
class FakeBrowser {
  /** The provider's copies by stored name, and how many reads answer "not yet" before each appears. */
  stored = new Map<string, { bytes: Buffer; pendingReads: number }>()
  connections: FakeConnection[] = []
  get current() { return this.connections[this.connections.length - 1] }
  /** The page starts a download: the provider stores it under its guid; a live connection hears of it. */
  download(guid: string, suggestedFilename: string, content: string, extra: { url?: string; frameId?: string; pendingReads?: number; complete?: boolean } = {}) {
    const url = extra.url ?? `https://example.com/${suggestedFilename}`
    this.current?.emit('Browser.downloadWillBegin', { guid, suggestedFilename, url, frameId: extra.frameId ?? 'FRAME-A' })
    if (extra.complete === false) return
    this.complete(guid, content, extra.pendingReads ?? 0)
  }
  complete(guid: string, content: string, pendingReads = 0) {
    this.stored.set(guid, { bytes: Buffer.from(content), pendingReads })
    this.current?.emit('Browser.downloadProgress', { guid, state: 'inProgress', totalBytes: content.length, receivedBytes: content.length })
    this.current?.emit('Browser.downloadProgress', { guid, state: 'completed', totalBytes: content.length, receivedBytes: content.length })
  }
}

let dir: string
let browser: FakeBrowser
let read: ReturnType<typeof vi.fn<(guid: string) => Promise<HostFileAnswer>>>
let list: ReturnType<typeof vi.fn<() => Promise<HostListAnswer>>>

function watcher(overrides: Partial<ConstructorParameters<typeof DownloadWatcher>[0]> = {}) {
  return new DownloadWatcher({
    connectBrowser: async () => {
      const connection = new FakeConnection()
      browser.connections.push(connection)
      return connection as unknown as CdpConnection
    },
    host: { read, list },
    downloadsDir: dir,
    pollMs: 5,
    fetchWaitMs: 500,
    ...overrides,
  })
}

/** A watcher as the browser opens: its first look at the provider's files done, then connected. */
async function connected(overrides: Parameters<typeof watcher>[0] = {}) {
  const w = watcher(overrides)
  w.start()
  await vi.waitFor(() => expect(list).toHaveBeenCalled())
  await w.ensure()
  return w
}

const saved = (name: string) => path.join(dir, name)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-watcher-'))
  browser = new FakeBrowser()
  read = vi.fn(async (guid: string) => {
    const copy = browser.stored.get(guid)
    if (!copy || copy.pendingReads-- > 0) return { kind: 'pending' as const }
    return { kind: 'file' as const, bytes: copy.bytes }
  })
  list = vi.fn(async () => ({ kind: 'files' as const, names: [...browser.stored.keys()] }))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('DownloadWatcher', () => {
  it('sets allowAndName with events on, over a connection it keeps open', async () => {
    const w = await connected()
    expect(browser.current.sent).toEqual([{ method: 'Browser.setDownloadBehavior', params: CLOUD_DOWNLOAD_BEHAVIOR }])
    expect(CLOUD_DOWNLOAD_BEHAVIOR).toEqual({ behavior: 'allowAndName', downloadPath: 'downloads', eventsEnabled: true })
    expect(browser.current.isClosed).toBe(false)
    await w.ensure()
    expect(browser.connections).toHaveLength(1)
  })

  it("saves a completed download under the page's name once the provider has it, and reports it once", async () => {
    const w = await connected()
    const since = Date.now()
    browser.download('guid-1', 'seo-agent-516019-aaf0252f7bad.json', '{"type":"service_account"}', { pendingReads: 2 })

    expect(await w.report(since, 2_000)).toEqual([
      { suggestedFilename: 'seo-agent-516019-aaf0252f7bad.json', saved: { path: saved('seo-agent-516019-aaf0252f7bad.json'), size: 26 } },
    ])
    expect(fs.readFileSync(saved('seo-agent-516019-aaf0252f7bad.json'), 'utf8')).toBe('{"type":"service_account"}')
    expect(read).toHaveBeenCalledWith('guid-1')
    expect(await w.report(since, 10)).toEqual([])
  })

  it('keeps both of two downloads with the same name', async () => {
    const w = await connected()
    const since = Date.now()
    browser.download('a', 'report.csv', 'first')
    browser.download('b', 'report.csv', 'second')
    const reports = await w.report(since, 2_000)
    expect(reports.map((r) => r.saved?.path).sort()).toEqual([saved('report-1.csv'), saved('report.csv')])
    expect(fs.readdirSync(dir).sort()).toEqual(['report-1.csv', 'report.csv'])
  })

  it("reduces the page's name to a safe basename", async () => {
    const w = await connected()
    browser.download('g', '../../etc/passwd', 'x')
    const [report] = await w.report(0, 2_000)
    expect(report.saved?.path).toBe(saved('passwd'))
  })

  it('reports a canceled download as not saved, without asking the host', async () => {
    const w = await connected()
    browser.download('g', 'big.zip', '', { complete: false })
    browser.current.emit('Browser.downloadProgress', { guid: 'g', state: 'canceled' })
    expect(await w.report(0, 100)).toEqual([{ suggestedFilename: 'big.zip', failed: 'The browser reported the download canceled.' }])
    expect(read).not.toHaveBeenCalled()
  })

  it('stops asking when the host says the provider keeps no copy', async () => {
    read.mockResolvedValue({ kind: 'unavailable', message: "Tab Tender keeps no copy of the browser's downloads that the app can read" })
    const w = await connected()
    browser.download('g', 'a.pdf', 'pdf')
    expect(await w.report(0, 2_000)).toEqual([{ suggestedFilename: 'a.pdf', failed: "Tab Tender keeps no copy of the browser's downloads that the app can read" }])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('gives up after the wait, saying the provider listed no copy, or what the last read failed with', async () => {
    const w = await connected({ fetchWaitMs: 40 })
    browser.current.emit('Browser.downloadWillBegin', { guid: 'never', suggestedFilename: 'a.pdf', url: 'https://x/a.pdf' })
    browser.current.emit('Browser.downloadProgress', { guid: 'never', state: 'completed' })
    expect(await w.report(0, 2_000)).toEqual([{ suggestedFilename: 'a.pdf', failed: 'The browser provider listed no copy of it 0 s after the browser finished it.' }])

    read.mockRejectedValue(new Error('Browserbase answered 500'))
    browser.download('broken', 'b.pdf', 'pdf')
    expect(await w.report(0, 2_000)).toEqual([{ suggestedFilename: 'b.pdf', failed: "Reading the browser provider's copy failed: Browserbase answered 500" }])
  })

  it("names a download still under way when the action's wait runs out, and the saved file in a later result", async () => {
    const w = await connected()
    const since = Date.now()
    browser.download('slow', 'export.csv', '', { complete: false })
    expect(await w.report(since, 20)).toEqual([{ suggestedFilename: 'export.csv', inProgress: 'downloading' }])
    browser.complete('slow', 'a,b')
    await vi.waitFor(() => expect(fs.existsSync(saved('export.csv'))).toBe(true))
    expect(await w.report(Date.now(), 10)).toEqual([{ suggestedFilename: 'export.csv', saved: { path: saved('export.csv'), size: 3 } }])
  })

  it("leaves the downloads of another session's tab for that session", async () => {
    const w = await connected()
    browser.download('theirs', 'theirs.txt', 'x', { frameId: 'FRAME-B' })
    await vi.waitFor(() => expect(fs.existsSync(saved('theirs.txt'))).toBe(true))
    expect(await w.report(0, 50, (frameId) => frameId !== 'FRAME-B')).toEqual([])
    expect(await w.report(0, 50, (frameId) => frameId === 'FRAME-B')).toEqual([{ suggestedFilename: 'theirs.txt', saved: { path: saved('theirs.txt'), size: 1 } }])
  })

  it('does not save again the download a browser_download call starts for its own URL, then or later', async () => {
    const w = await connected()
    const url = 'https://example.com/report.pdf'
    await w.ignoring(url, () => false, async () => browser.download('own', 'report.pdf', 'pdf', { url }))
    expect(await w.report(0, 50)).toEqual([])
    expect(read).not.toHaveBeenCalled()
    // Nor does a catch-up take it for one it missed.
    browser.current.close()
    await w.ensure()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(read).not.toHaveBeenCalled()
    // A click on the same link once the call is over is saved.
    browser.download('click', 'report.pdf', 'pdf', { url })
    expect((await w.report(0, 2_000))[0].saved?.path).toBe(saved('report.pdf'))
  })

  it('sets the behaviour again on reapply, and connects again when its socket has gone', async () => {
    const w = await connected()
    await w.reapply()
    expect(browser.current.sent).toHaveLength(2)
    browser.current.close()
    await w.ensure()
    expect(browser.connections).toHaveLength(2)
    expect(browser.current.sent).toEqual([{ method: 'Browser.setDownloadBehavior', params: CLOUD_DOWNLOAD_BEHAVIOR }])
  })

  it("does not save the download of browser_download's own tab when a redirect changed its URL", async () => {
    const w = await connected()
    const ownTab = (frameId: string | undefined) => frameId === 'PLAYWRIGHT-TAB'
    await w.ignoring('https://example.com/export', ownTab, async () => {
      browser.download('own', 'export.csv', 'a,b', { url: 'https://cdn.example.com/signed/export.csv?sig=1', frameId: 'PLAYWRIGHT-TAB' })
    })
    expect(await w.report(0, 50)).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('fetches nothing the provider had before it first connected', async () => {
    browser.stored.set('old-guid', { bytes: Buffer.from('from an earlier container'), pendingReads: 0 })
    const w = await connected()
    browser.current.close()
    await w.ensure()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(read).not.toHaveBeenCalled()
    expect(await w.report(0, 10)).toEqual([])
  })

  it('after its socket dropped, fetches what the browser downloaded meanwhile, under the name the provider gave it', async () => {
    const w = await connected()
    browser.current.close()
    // Heard by no one: the provider stores it all the same.
    browser.download('missed-guid', 'missed.csv', 'k,v')
    expect(fs.readdirSync(dir)).toEqual([])
    await w.ensure()
    await vi.waitFor(() => expect(fs.existsSync(saved('missed-guid'))).toBe(true))
    expect(fs.readFileSync(saved('missed-guid'), 'utf8')).toBe('k,v')
    expect(await w.report(Date.now(), 10)).toEqual([{ suggestedFilename: 'missed-guid', saved: { path: saved('missed-guid'), size: 3 } }])
  })

  it('leaves alone a download still under way (not listed yet), and files still being written', async () => {
    const w = await connected()
    browser.download('live', 'live.csv', '', { complete: false })
    browser.stored.set('other.crdownload', { bytes: Buffer.from('partial'), pendingReads: 0 })
    browser.current.close()
    await w.ensure()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(read).not.toHaveBeenCalled()
  })

  it('fetches, under the page\'s name, a download that finished after its socket dropped', async () => {
    const w = await connected()
    const since = Date.now()
    browser.download('mid', 'export.csv', '', { complete: false })
    browser.current.close()
    // It finishes while nobody listens: the new connection hears nothing of it.
    browser.stored.set('mid', { bytes: Buffer.from('a,b'), pendingReads: 0 })
    await w.ensure()
    await vi.waitFor(() => expect(fs.existsSync(saved('export.csv'))).toBe(true))
    expect(await w.report(since, 1_000)).toEqual([{ suggestedFilename: 'export.csv', saved: { path: saved('export.csv'), size: 3 } }])
  })

  it('treats every listing as the baseline until one succeeds, so an old file is never fetched as new', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    browser.stored.set('old-guid', { bytes: Buffer.from('old'), pendingReads: 0 })
    list.mockRejectedValueOnce(new Error('host answered 502'))
    const w = await connected()
    browser.current.close()
    await w.ensure()
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    expect(read).not.toHaveBeenCalled()
    // From then on new files are fetched.
    browser.current.close()
    browser.download('new-guid', 'new.txt', 'new')
    await w.ensure()
    await vi.waitFor(() => expect(fs.existsSync(saved('new-guid'))).toBe(true))
    expect(fs.existsSync(saved('old-guid'))).toBe(false)
  })

  it('backs off after a failed connection instead of trying on every action', async () => {
    let attempts = 0
    const w = watcher({
      reconnectBackoffMs: 60_000,
      connectBrowser: async () => { attempts++; throw new Error('Could not connect to the browser') },
    })
    await expect(w.ensure()).rejects.toThrow('Could not connect')
    await w.ensure()
    await w.ensure()
    expect(attempts).toBe(1)
  })

  it('lets go of a connection that opened while it was closing', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const connection = new FakeConnection()
    connection.send = async (method: string) => { await gate; connection.sent.push({ method, params: {} }); return {} }
    const w = watcher({ connectBrowser: async () => connection as unknown as CdpConnection })
    const connecting = w.ensure()
    await w.close()
    release()
    await connecting
    expect(connection.isClosed).toBe(true)
  })

  it('names a download the browser finished whose copy is not read yet as such', async () => {
    const w = await connected()
    const since = Date.now()
    browser.download('slow-copy', 'big.zip', 'zip', { pendingReads: 1_000 })
    expect(await w.report(since, 20)).toEqual([{ suggestedFilename: 'big.zip', inProgress: 'fetching' }])
  })

  it('on close, lets downloads being fetched land and fetches any it missed, then hands them over', async () => {
    const w = await connected()
    browser.download('late', 'late.txt', 'late', { pendingReads: 5 })
    browser.current.close()
    browser.download('unheard', 'unheard.txt', 'unheard')
    const reports = await w.close(2_000)
    expect(reports).toEqual(expect.arrayContaining([
      { suggestedFilename: 'late.txt', saved: { path: saved('late.txt'), size: 4 } },
      { suggestedFilename: 'unheard', saved: { path: saved('unheard'), size: 7 } },
    ]))
    expect(reports).toHaveLength(2)
    await w.ensure()
    expect(browser.connections).toHaveLength(1)
  })

  it('on close, takes no old file for new even when it never connected', async () => {
    browser.stored.set('old-guid', { bytes: Buffer.from('old'), pendingReads: 0 })
    const w = watcher({ connectBrowser: async () => { throw new Error('Could not connect to the browser') } })
    w.start()
    await expect(w.ensure()).rejects.toThrow('Could not connect')
    // Downloaded while nobody listened: fetched at close, the old file not.
    browser.stored.set('unheard', { bytes: Buffer.from('new'), pendingReads: 0 })
    expect(await w.close(2_000)).toEqual([{ suggestedFilename: 'unheard', saved: { path: saved('unheard'), size: 3 } }])
    expect(fs.existsSync(saved('old-guid'))).toBe(false)
  })

  it('keeps watching when the listing fails, and tries again at the next catch-up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    list.mockRejectedValueOnce(new Error('host down'))
    const w = await connected()
    browser.download('g', 'a.txt', 'a')
    expect((await w.report(0, 2_000))[0].saved?.path).toBe(saved('a.txt'))
  })

  it('ignores progress for a download it never saw begin', async () => {
    await connected()
    browser.current.emit('Browser.downloadProgress', { guid: 'unknown', state: 'completed' })
    expect(read).not.toHaveBeenCalled()
  })
})

describe('DownloadWatcher for a browser that saves into the workspace itself', () => {
  function local() {
    return new DownloadWatcher({
      connectBrowser: async () => {
        const connection = new FakeConnection()
        browser.connections.push(connection)
        return connection as unknown as CdpConnection
      },
      downloadsDir: dir,
    })
  }
  /** The browser saved it where its event says. */
  function completeHere(guid: string, name: string, content: string) {
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, content)
    browser.current.emit('Browser.downloadProgress', { guid, state: 'completed', filePath })
  }

  it("keeps agent-browser's own behaviour in force, with events on, and asks no host", async () => {
    const w = local()
    w.start()
    await w.ensure()
    expect(browser.current.sent).toEqual([{ method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: dir, eventsEnabled: true } }])
    await w.reapply()
    expect(browser.current.sent).toHaveLength(2)
    expect(list).not.toHaveBeenCalled()
  })

  it('names the file the browser saved, where it saved it', async () => {
    const w = local()
    await w.ensure()
    const since = Date.now()
    browser.current.emit('Browser.downloadWillBegin', { guid: 'g', suggestedFilename: 'report.csv', url: 'https://x/report.csv', frameId: 'F' })
    completeHere('g', 'report (1).csv', 'a,b')
    expect(await w.report(since, 1_000)).toEqual([{ suggestedFilename: 'report.csv', saved: { path: path.join(dir, 'report (1).csv'), size: 3 } }])
    expect(read).not.toHaveBeenCalled()
  })

  it('says so when the browser saved it elsewhere', async () => {
    const w = local()
    await w.ensure()
    browser.current.emit('Browser.downloadWillBegin', { guid: 'g', suggestedFilename: 'x.txt', url: 'https://x/x.txt' })
    browser.current.emit('Browser.downloadProgress', { guid: 'g', state: 'completed', filePath: '/tmp/playwright-artifacts/g' })
    expect(await w.report(0, 1_000)).toEqual([{ suggestedFilename: 'x.txt', failed: 'The browser saved it outside /workspace/downloads/, at /tmp/playwright-artifacts/g.' }])
  })

  it('closes with nothing to catch up on', async () => {
    const w = local()
    await w.ensure()
    expect(await w.close(1_000)).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })
})

describe('hostDownloads', () => {
  const env = { HOST_APP_URL: 'http://host:47891', PROXY_TOKEN: 'tok', AGENT_ID: 'agent-a' }

  it("asks the host for the session's file by guid and name, with the agent's token, and returns the bytes", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await hostDownloads('sess-1', env).read('g')).toEqual({ kind: 'file', bytes: Buffer.from([1, 2, 3]) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://host:47891/api/browser/download-file')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual({ agentId: 'agent-a', sessionId: 'sess-1', guid: 'g' })
  })

  it("lists the session's stored files", async () => {
    const fetchMock = vi.fn(async () => Response.json({ files: [{ name: 'g1', size: 3 }, { name: 'notes.txt', size: null }] }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await hostDownloads('sess-1', env).list()).toEqual({ kind: 'files', names: ['g1', 'notes.txt'] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://host:47891/api/browser/downloads')
    expect(JSON.parse(String(init.body))).toEqual({ agentId: 'agent-a', sessionId: 'sess-1' })
  })

  it('reads 404 as not there yet, 501, 403 and 413 as never, and anything else as a failed read', async () => {
    const answer = (status: number, error: string) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error }, { status })))
      return hostDownloads('sess-1', env).read('g')
    }
    expect(await answer(404, 'not_found')).toEqual({ kind: 'pending' })
    expect(await answer(501, 'Tab Tender keeps no copy')).toEqual({ kind: 'unavailable', message: 'Tab Tender keeps no copy' })
    expect(await answer(403, "That browser session is not this agent's")).toEqual({ kind: 'unavailable', message: "That browser session is not this agent's" })
    expect(await answer(413, 'too large')).toEqual({ kind: 'unavailable', message: 'too large' })
    await expect(answer(502, 'Browserbase answered 500')).rejects.toThrow('Browserbase answered 500')
  })

  it('cannot ask without the host URL', async () => {
    expect(await hostDownloads('sess-1', {}).read('g')).toMatchObject({ kind: 'unavailable' })
    expect(await hostDownloads('sess-1', {}).list()).toMatchObject({ kind: 'unavailable' })
  })
})

describe('formatDownloadReports', () => {
  it('states what was saved where, what was not and why, and what is under way', () => {
    expect(formatDownloadReports(undefined)).toBe('')
    expect(formatDownloadReports([
      { suggestedFilename: 'key.json', saved: { path: '/workspace/downloads/key.json', size: 2360 } },
      { suggestedFilename: 'big.zip', inProgress: 'downloading' },
      { suggestedFilename: 'huge.zip', inProgress: 'fetching' },
      { suggestedFilename: 'x.pdf', failed: 'The browser reported the download canceled.' },
    ])).toBe(
      '\nDownload "key.json" saved to /workspace/downloads/key.json (2360 bytes).'
      + '\nDownload "big.zip" began and had not finished when this result was written.'
      + '\nDownload "huge.zip" finished in the browser; its copy had not been read from the browser provider when this result was written.'
      + '\nDownload "x.pdf" was not saved to /workspace/downloads/: The browser reported the download canceled.',
    )
  })
})
