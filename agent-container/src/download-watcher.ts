/**
 * The downloads a page starts in the agent's browser (a clicked "Export" or
 * "Create key"), seen through to /workspace/downloads and named in the
 * result of the action that started them.
 *
 * Chrome tells of a download only over CDP, and the page's name for the file
 * is only there. The one CDP client that hears it already is agent-browser,
 * which reports it nowhere we read (0.45.0: `wait --download` answers
 * `{ completed: true }`, no guid or name). So the watcher holds a
 * browser-level connection of its own while the browser is open: one idle
 * socket, nothing per action. On it, it sets the download behaviour with
 * events on, and follows each download to its end.
 *
 * Two kinds of browser need one:
 * - A cloud browser (Browserbase, Steel) saves a download on the provider's
 *   machine, which the container cannot see. The provider keeps it and serves
 *   it from its API, which the host can call (it holds the account's key).
 *   When a download completes the watcher asks the host for that copy by the
 *   download's guid, and saves it in /workspace/downloads under the name the
 *   page gave it.
 * - The container's own Chrome saves into /workspace/downloads itself, under
 *   the page's name (`local`): the watcher only keeps it able to. That Chrome
 *   (the headless shell) refuses a download unless told where to save it;
 *   agent-browser tells it at launch, and the first Playwright connection to
 *   come and go (browser_upload, browser_download) undoes that for good.
 * Chrome on the host saves into the host side of /workspace/downloads from
 * its profile's preferences, whatever happens over CDP, and needs none.
 *
 * What the browsers do, measured on Chrome, Browserbase and Steel (2026-11-27):
 * - Browserbase and Steel keep every download whoever is listening; under
 *   `default` Browserbase's Chrome cancels it, so the watcher sets
 *   `allowAndName`. Both then store it under its guid: the guid finds the one
 *   file, even when two downloads have the same name.
 * - A behaviour lasts while the connection that set it is open; when that
 *   connection goes, Chrome's default is back. Playwright's connectOverCDP
 *   sets its own, and once it has left the watcher hears of no download until
 *   it sets the behaviour again: it does, after each (`reapply`).
 *
 * A cloud browser's watcher can lose its socket. The provider still keeps
 * what the browser downloads meanwhile, so whenever the watcher connects
 * again, and when the browser closes, it lists the session's files
 * (`catchUp`) and fetches any it never heard of (it keeps the provider's name
 * for it), and any it heard begin but never heard finish (a new connection
 * hears nothing of a download begun before it). The first listing, as the
 * browser opens and before any page does, only notes what is there already (a
 * session the provider gave back after a restart has old files); until one
 * succeeds, every listing only notes, so an old file is never fetched as new.
 *
 * A download the watcher fetched is found by its guid alone: with the
 * watcher's behaviour in force (it is whenever the watcher hears of one),
 * the provider stores it under that guid.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { CdpConnection, CdpEvent } from './login-cdp'
import { DOWNLOADS_DIR, MAX_DOWNLOAD_BYTES, sanitizeFilename, writeDownloadFile } from './browser-download'
import { downloadProgressSchema, downloadWillBeginSchema, hostDownloadErrorSchema, hostDownloadListSchema } from './download-watcher-schemas'

/**
 * Browserbase keeps a download only under a download path of exactly
 * `downloads` (its docs); Steel saves every download in the session's
 * `/files` whatever the path.
 */
export const CLOUD_DOWNLOAD_BEHAVIOR = { behavior: 'allowAndName', downloadPath: 'downloads', eventsEnabled: true } as const

/** The container's own Chrome: what agent-browser sets at launch (AGENT_BROWSER_DOWNLOAD_PATH), with events on. */
export function localDownloadBehavior(downloadsDir: string) {
  return { behavior: 'allow', downloadPath: downloadsDir, eventsEnabled: true } as const
}

/** How long a finished download waits for the provider's copy (Browserbase's own SDK example waits 20 s). */
const FETCH_WAIT_MS = 30_000
const POLL_MS = 1_000
/** One host read may move up to the download cap. */
const HOST_READ_TIMEOUT_MS = 120_000
const HOST_LIST_TIMEOUT_MS = 30_000
/** After a failed connection, how long actions go on without trying again (each try may wait out a timeout). */
const RECONNECT_BACKOFF_MS = 30_000

/** A download, as an action's result names it. */
export interface DownloadReport {
  /** The name the page gave the file (the provider's name, for one found by a catch-up). */
  suggestedFilename: string
  /** Saved into the workspace: where, and how large. */
  saved?: { path: string; size: number }
  /** Not saved: what was seen. */
  failed?: string
  /**
   * Not saved yet when the result was written: still downloading in the
   * browser, or finished there and its copy not yet read from the provider.
   */
  inProgress?: 'downloading' | 'fetching'
}

/** What the host answered for a download. */
export type HostFileAnswer =
  | { kind: 'file'; bytes: Buffer }
  /** The provider does not have it yet: ask again. */
  | { kind: 'pending' }
  /** The provider never will (no downloads API, the file is too large): asking again changes nothing. */
  | { kind: 'unavailable'; message: string }

/** What the host answered for the session's files. */
export type HostListAnswer =
  | { kind: 'files'; names: string[] }
  | { kind: 'unavailable'; message: string }

/** The host's side, for one browser session. */
export interface RemoteDownloadsHost {
  /** One file, by the download's guid (or the name a listing gave). */
  read(guid: string): Promise<HostFileAnswer>
  list(): Promise<HostListAnswer>
}

export interface DownloadWatcherDeps {
  connectBrowser: () => Promise<CdpConnection>
  /** A cloud browser's: where its files are read from. Absent: the browser saves into `downloadsDir` itself. */
  host?: RemoteDownloadsHost
  /** Defaults to /workspace/downloads. */
  downloadsDir?: string
  fetchWaitMs?: number
  pollMs?: number
  reconnectBackoffMs?: number
}

/** A browser_download call under way: the downloads its own tab starts are its own. */
interface Ignored {
  url: string
  /** Whether a download from this frame is the call's (its tab is no session's). */
  ownFrame: (frameId: string | undefined) => boolean
}

interface Tracked {
  guid: string
  suggestedFilename: string
  frameId: string | undefined
  beganAt: number
  /** Saved or failed; null while it downloads or is being fetched. */
  outcome: DownloadReport | null
  fetching: boolean
  settled: Promise<void>
  settle: () => void
}

/** Wait for `work`, at most `ms`; the timer does not hold the process open. */
async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
  clearTimeout(timer)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export class DownloadWatcher {
  private connection: CdpConnection | null = null
  private connecting: Promise<void> | null = null
  private connectedOnce = false
  /** No connection is tried before this (a failed one backs off). */
  private retryAt = 0
  private readonly downloads = new Map<string, Tracked>()
  /** Stored names (guids) handled or found already there: a catch-up fetches only others. */
  private readonly known = new Set<string>()
  /** Whether a listing has noted what the provider had: until then every listing only notes. */
  private baselined = false
  /** Catch-ups run one at a time, in order. */
  private catchUps: Promise<void> = Promise.resolve()
  private readonly ignored = new Set<Ignored>()
  private closed = false

  constructor(private readonly deps: DownloadWatcherDeps) {}

  private get downloadsDir(): string {
    return this.deps.downloadsDir ?? DOWNLOADS_DIR
  }

  /** The behaviour this browser is kept on. */
  private get behavior() {
    return this.deps.host ? CLOUD_DOWNLOAD_BEHAVIOR : localDownloadBehavior(this.downloadsDir)
  }

  /** Note what the provider has already, as the browser opens: call before any page loads. */
  start(): void {
    void this.catchUp()
  }

  /** Hold the connection and the behaviour; connect again (and catch up) when the socket has gone. */
  ensure(): Promise<void> {
    if (this.closed || (this.connection && !this.connection.isClosed)) return Promise.resolve()
    if (!this.connecting && Date.now() < this.retryAt) return Promise.resolve()
    this.connecting ??= this.connect()
      .catch((error: unknown) => {
        this.retryAt = Date.now() + (this.deps.reconnectBackoffMs ?? RECONNECT_BACKOFF_MS)
        throw error
      })
      .finally(() => { this.connecting = null })
    return this.connecting
  }

  private async connect(): Promise<void> {
    const connection = await this.deps.connectBrowser()
    try {
      if (this.closed) throw new Error('closed')
      connection.onEvent((event) => this.onEvent(event))
      await connection.send('Browser.setDownloadBehavior', this.behavior)
      if (this.closed) throw new Error('closed')
    } catch (error) {
      connection.close()
      if (this.closed) return
      throw error
    }
    this.connection = connection
    // After a drop: what the browser downloaded while nobody listened.
    // Not awaited: the action that asked goes on; its own downloads come by events.
    if (this.connectedOnce) void this.catchUp()
    this.connectedOnce = true
  }

  /** Set the behaviour again: a Playwright connection that came and went reset it. */
  async reapply(): Promise<void> {
    if (this.connection && !this.connection.isClosed) {
      await this.connection.send('Browser.setDownloadBehavior', this.behavior)
      return
    }
    await this.ensure()
  }

  /**
   * Run a browser_download fetch of `url`: the download its own tab starts is
   * not one to save again. That tab's download is recognised by the URL, or
   * (when a redirect changed the URL) by coming from a frame `ownFrame` takes.
   */
  async ignoring<T>(url: string, ownFrame: (frameId: string | undefined) => boolean, work: () => Promise<T>): Promise<T> {
    const entry: Ignored = { url, ownFrame }
    this.ignored.add(entry)
    try {
      return await work()
    } finally {
      this.ignored.delete(entry)
    }
  }

  /**
   * The downloads to name in an action's result. Waits, up to `maxWaitMs`, for
   * those that began at or after `since` to be saved or fail; then hands over
   * every download that has been and was not named yet, and those that began
   * since and are still downloading. `accepts` picks the downloads by the
   * frame that started them (another session's tab is that session's).
   */
  async report(since: number, maxWaitMs: number, accepts: (frameId: string | undefined) => boolean = () => true): Promise<DownloadReport[]> {
    const waiting = [...this.downloads.values()].filter((t) => t.beganAt >= since && !t.outcome && accepts(t.frameId))
    if (waiting.length > 0) await within(Promise.all(waiting.map((t) => t.settled)), maxWaitMs)
    return this.take(accepts, since)
  }

  /**
   * Stop watching, and hand over what was not named yet. First, up to
   * `drainMs`: downloads being fetched land, and the session's files are
   * checked for any the watcher never heard of. The host can still read the
   * session after the browser stops; this is the last chance to look.
   */
  async close(drainMs = 0): Promise<DownloadReport[]> {
    if (drainMs > 0 && !this.closed) {
      const fetching = [...this.downloads.values()].filter((t) => t.fetching && !t.outcome)
      await within(Promise.all([...fetching.map((t) => t.settled), this.catchUp()]), drainMs)
    }
    this.closed = true
    this.connection?.close()
    this.connection = null
    return drainMs > 0 ? this.take(() => true, Number.POSITIVE_INFINITY) : []
  }

  /** Hand over the finished downloads `accepts` takes, and those begun since `since` still under way. */
  private take(accepts: (frameId: string | undefined) => boolean, since: number): DownloadReport[] {
    const reports: DownloadReport[] = []
    for (const t of [...this.downloads.values()]) {
      if (!accepts(t.frameId)) continue
      if (t.outcome) {
        reports.push(t.outcome)
        this.downloads.delete(t.guid)
      } else if (t.beganAt >= since) {
        reports.push({ suggestedFilename: t.suggestedFilename, inProgress: t.fetching ? 'fetching' : 'downloading' })
      }
    }
    return reports
  }

  /**
   * List the session's files. Until a listing has succeeded, only note them
   * (the baseline). After it, fetch those the watcher never heard of, and
   * those it heard begin but not finish. Never rejects: a failure is logged,
   * and the next catch-up tries again.
   */
  private catchUp(): Promise<void> {
    // A browser that saves into the workspace itself has nothing elsewhere to catch up on.
    if (!this.deps.host) return Promise.resolve()
    const run = this.catchUps.then(() => this.catchUpOnce()).catch((error: unknown) => {
      console.error("[Browser] Could not catch up on the browser's downloads:", message(error))
    })
    this.catchUps = run
    return run
  }

  private async catchUpOnce(): Promise<void> {
    if (!this.deps.host) return
    const answer = await this.deps.host.list()
    if (answer.kind === 'unavailable') return
    const baseline = !this.baselined
    this.baselined = true
    for (const name of answer.names) {
      if (name.endsWith('.crdownload')) continue
      const tracked = this.downloads.get(name)
      if (tracked) {
        // Heard begin, never heard finish (its events went with a dropped socket): the provider has it now.
        if (!baseline && !tracked.outcome && !tracked.fetching) await this.fetchListed(tracked)
        continue
      }
      if (this.known.has(name)) continue
      this.known.add(name)
      // Heard of by no event: its only name is the provider's.
      if (!baseline) await this.fetchListed(this.track(name, name, undefined))
    }
  }

  /** Fetch a file the provider just listed: one read. */
  private async fetchListed(tracked: Tracked): Promise<void> {
    tracked.fetching = true
    await this.fetch(tracked, { once: true }).catch((error: unknown) => this.finish(tracked, { failed: message(error) }))
  }

  private track(guid: string, suggestedFilename: string, frameId: string | undefined): Tracked {
    let settle: () => void = () => {}
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const tracked: Tracked = { guid, suggestedFilename, frameId, beganAt: Date.now(), outcome: null, fetching: false, settled, settle }
    this.downloads.set(guid, tracked)
    return tracked
  }

  private onEvent(event: CdpEvent): void {
    if (event.method === 'Browser.downloadWillBegin') {
      const parsed = downloadWillBeginSchema.safeParse(event.params)
      if (!parsed.success) return
      const { guid, url, suggestedFilename, frameId } = parsed.data
      if (this.known.has(guid)) return
      this.known.add(guid)
      const ownedByCall = [...this.ignored].some((entry) => entry.url === url || entry.ownFrame(frameId))
      if (!ownedByCall) this.track(guid, suggestedFilename, frameId)
      return
    }
    if (event.method === 'Browser.downloadProgress') {
      const parsed = downloadProgressSchema.safeParse(event.params)
      if (!parsed.success) return
      const tracked = this.downloads.get(parsed.data.guid)
      if (!tracked || tracked.outcome || tracked.fetching) return
      if (parsed.data.state === 'completed') {
        tracked.fetching = true
        const landed = this.deps.host ? this.fetch(tracked) : this.savedHere(tracked, parsed.data.filePath)
        landed.catch((error: unknown) => this.finish(tracked, { failed: message(error) }))
      } else if (parsed.data.state === 'canceled') {
        this.finish(tracked, { failed: 'The browser reported the download canceled.' })
      }
    }
  }

  private finish(t: Tracked, outcome: Omit<DownloadReport, 'suggestedFilename'>): void {
    if (t.outcome) return
    t.outcome = { suggestedFilename: t.suggestedFilename, ...outcome }
    t.settle()
  }

  /** A local browser's download: it saved the file itself, where its event says. */
  private async savedHere(t: Tracked, filePath: string | undefined): Promise<void> {
    if (!filePath) return this.finish(t, { failed: 'The browser did not say where it saved the file.' })
    const relative = path.relative(this.downloadsDir, filePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return this.finish(t, { failed: `The browser saved it outside /workspace/downloads/, at ${filePath}.` })
    }
    const { size } = await fs.promises.stat(filePath)
    this.finish(t, { saved: { path: filePath, size } })
  }

  /** Ask the host for the provider's copy until it has one (once, for a file already listed), then save it. */
  private async fetch(t: Tracked, options: { once?: boolean } = {}): Promise<void> {
    const waitMs = this.deps.fetchWaitMs ?? FETCH_WAIT_MS
    const deadline = Date.now() + waitMs
    let lastError: string | null = null
    for (;;) {
      let answer: HostFileAnswer | null = null
      try {
        answer = this.deps.host ? await this.deps.host.read(t.guid) : null
      } catch (error: unknown) {
        lastError = message(error)
      }
      if (answer?.kind === 'file') {
        if (answer.bytes.length > MAX_DOWNLOAD_BYTES) {
          return this.finish(t, { failed: `The file is ${answer.bytes.length} bytes, over the ${MAX_DOWNLOAD_BYTES} byte limit.` })
        }
        const saved = await writeDownloadFile(this.deps.downloadsDir ?? DOWNLOADS_DIR, sanitizeFilename(t.suggestedFilename || t.guid), answer.bytes)
        return this.finish(t, { saved: { path: saved, size: answer.bytes.length } })
      }
      if (answer?.kind === 'unavailable') return this.finish(t, { failed: answer.message })
      if (answer?.kind === 'pending') lastError = null
      if (options.once || Date.now() >= deadline) {
        const missing = options.once
          ? 'The browser provider had no copy of it when asked.'
          : `The browser provider listed no copy of it ${Math.round(waitMs / 1000)} s after the browser finished it.`
        return this.finish(t, { failed: lastError ? `Reading the browser provider's copy failed: ${lastError}` : missing })
      }
      await sleep(this.deps.pollMs ?? POLL_MS)
    }
  }
}

/** The host's downloads routes, for one of the agent's browser sessions (`/api/browser/downloads`, `/api/browser/download-file`). */
export function hostDownloads(sessionId: string, env: NodeJS.ProcessEnv = process.env): RemoteDownloadsHost {
  const post = (route: string, body: Record<string, unknown>, timeoutMs: number): Promise<Response> | null => {
    if (!env.HOST_APP_URL) return null
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (env.PROXY_TOKEN) headers.Authorization = `Bearer ${env.PROXY_TOKEN}`
    return fetch(`${env.HOST_APP_URL}/api/browser/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...(env.AGENT_ID ? { agentId: env.AGENT_ID } : {}), sessionId, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }
  const noHost = { kind: 'unavailable', message: 'HOST_APP_URL is not configured, so the host cannot be asked for the file.' } as const
  /** The error a non-2xx answer names; whether asking again could change it (501: no downloads to read, 403: not this agent's, 413: too large). */
  const refusal = async (response: Response) => {
    const body = hostDownloadErrorSchema.safeParse(await response.json().catch(() => null))
    return {
      message: body.success ? body.data.error : `The host answered ${response.status}.`,
      final: response.status === 501 || response.status === 403 || response.status === 413,
    }
  }
  return {
    async read(guid) {
      const request = post('download-file', { guid }, HOST_READ_TIMEOUT_MS)
      if (!request) return noHost
      const response = await request
      if (response.status === 200) return { kind: 'file', bytes: Buffer.from(await response.arrayBuffer()) }
      if (response.status === 404) return { kind: 'pending' }
      const { message: error, final } = await refusal(response)
      if (final) return { kind: 'unavailable', message: error }
      throw new Error(error)
    },
    async list() {
      const request = post('downloads', {}, HOST_LIST_TIMEOUT_MS)
      if (!request) return noHost
      const response = await request
      if (response.ok) return { kind: 'files', names: hostDownloadListSchema.parse(await response.json()).files.map((file) => file.name) }
      const { message: error, final } = await refusal(response)
      if (final) return { kind: 'unavailable', message: error }
      throw new Error(error)
    },
  }
}

/** The lines an action's result adds for the downloads it reports. Observations only. */
export function formatDownloadReports(reports: DownloadReport[] | undefined): string {
  if (!reports?.length) return ''
  return reports.map((report) => {
    const name = JSON.stringify(report.suggestedFilename)
    if (report.saved) return `\nDownload ${name} saved to ${report.saved.path} (${report.saved.size} bytes).`
    if (report.inProgress === 'downloading') return `\nDownload ${name} began and had not finished when this result was written.`
    if (report.inProgress === 'fetching') return `\nDownload ${name} finished in the browser; its copy had not been read from the browser provider when this result was written.`
    return `\nDownload ${name} was not saved to /workspace/downloads/: ${report.failed}`
  }).join('')
}
