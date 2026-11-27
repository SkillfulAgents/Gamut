/**
 * The files a Browserbase session's browser downloaded. Browserbase keeps
 * every download a session makes in its own storage, whatever download
 * behaviour is set or by whom (measured 2026-11-27: a clicked blob, data: and
 * attachment download alike, before and after a Playwright connection came
 * and went), named by the CDP download guid, and serves them from its
 * Downloads API: `GET /v1/downloads?sessionId=…` lists a session's files,
 * `GET /v1/downloads/{id}` with `Accept: application/octet-stream` reads one.
 * A file appears a moment after the browser finishes it, so a read that finds
 * nothing yet answers null and the caller asks again. A session keeps its
 * `contextId` and its files after it ends.
 *
 * Shared by the Browserbase provider (the account's own key) and the platform
 * provider (Browserbase through the platform's proxy).
 */
import { browserbaseDownloadListSchema, browserbaseSessionSchema, type BrowserbaseDownload } from './browserbase-schemas'
import {
  DownloadTooLargeError,
  DownloadsUnsupportedError,
  MAX_BROWSER_DOWNLOAD_BYTES,
  SessionNotOwnedError,
  assertSessionOwned,
  findStoredDownload,
} from './downloads'
import type { BrowserDownloadRef, StoredDownload } from './types'

const PAGE_SIZE = 100
/** A session's downloads are few; the page cap only stops a runaway listing. */
const MAX_PAGES = 10
const REQUEST_TIMEOUT_MS = 60_000

export interface BrowserbaseDownloadsApi {
  /** The API base the paths go under: `https://api.browserbase.com/v1`, or the proxy's. */
  base: string
  headers: Record<string, string>
  /**
   * Set when a 404 on the listing means the endpoint is not there at all, not
   * that the session has no files: the platform proxy answers 404 for a path
   * it does not pass through. The message says so.
   */
  unsupportedOn404?: string
}

async function failed(response: Response, what: string): Promise<Error> {
  return new Error(`Browserbase answered ${response.status} ${what}: ${(await response.text()).slice(0, 300)}`)
}

/** Throw unless the session was created on the agent's context (`contextId`: the agent's mapping, null for none). */
export async function assertBrowserbaseSessionOn(api: BrowserbaseDownloadsApi, sessionId: string, contextId: string | null): Promise<void> {
  const response = await fetch(`${api.base}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: api.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) throw new SessionNotOwnedError()
  if (!response.ok) throw await failed(response, 'reading the session')
  assertSessionOwned(browserbaseSessionSchema.parse(await response.json()).contextId, contextId)
}

async function listStored(api: BrowserbaseDownloadsApi, sessionId: string): Promise<BrowserbaseDownload[]> {
  const listed: BrowserbaseDownload[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ sessionId, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    const response = await fetch(`${api.base}/downloads?${query}`, {
      headers: api.headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404 && api.unsupportedOn404) throw new DownloadsUnsupportedError(api.unsupportedOn404)
    if (!response.ok) throw await failed(response, "listing the session's downloads")
    const { downloads } = browserbaseDownloadListSchema.parse(await response.json())
    // Only the session's own, whatever the answer holds: the project is shared (the platform's is every user's).
    listed.push(...downloads.filter((file) => file.sessionId === sessionId))
    if (downloads.length < PAGE_SIZE) break
  }
  return listed
}

export async function listBrowserbaseDownloads(api: BrowserbaseDownloadsApi, sessionId: string): Promise<StoredDownload[]> {
  return (await listStored(api, sessionId)).map((file) => ({ name: file.filename, size: file.size ?? null }))
}

export async function readBrowserbaseDownload(
  api: BrowserbaseDownloadsApi,
  sessionId: string,
  download: BrowserDownloadRef,
): Promise<Buffer | null> {
  const stored = findStoredDownload(await listStored(api, sessionId), (file) => file.filename, download)
  if (!stored) return null
  if (stored.size != null && stored.size > MAX_BROWSER_DOWNLOAD_BYTES) throw new DownloadTooLargeError(stored.size)

  const response = await fetch(`${api.base}/downloads/${encodeURIComponent(stored.id)}`, {
    headers: { ...api.headers, Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw await failed(response, `reading download ${stored.id}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_BROWSER_DOWNLOAD_BYTES) throw new DownloadTooLargeError(bytes.length)
  return bytes
}
