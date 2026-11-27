/**
 * What every cloud provider's downloads share. A cloud browser saves a
 * download on the provider's machine; the container asks the host for it
 * (`/api/browser/downloads`, `/api/browser/download-file`), and the provider
 * reads it from its API. The container sets `Browser.setDownloadBehavior` to
 * `allowAndName`, so the browser saves each file under its download guid
 * (measured 2026-11-27: Browserbase under any behaviour, Steel under this
 * one): the guid finds the one file even when two have the same name.
 *
 * The requests name the provider's session, and each read checks it is the
 * agent's against the agent's context (Browserbase) or profile (Steel)
 * mapping, which the database keeps: nothing is kept in memory, so on
 * Cloudflare any Worker isolate answers.
 */
import type { BrowserDownloadRef } from './types'

/**
 * The most a download read hands over: the container buffers the whole file,
 * as it does for `browser_download` (agent-container browser-download.ts).
 */
export const MAX_BROWSER_DOWNLOAD_BYTES = 100 * 1024 * 1024

/** The provider keeps no copy of downloads this app can read (no API, or one the account cannot reach). */
export class DownloadsUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadsUnsupportedError'
  }
}

/** The download is larger than MAX_BROWSER_DOWNLOAD_BYTES. */
export class DownloadTooLargeError extends Error {
  constructor(size: number) {
    super(`The file is ${size} bytes, over the ${MAX_BROWSER_DOWNLOAD_BYTES} byte limit for a browser download`)
    this.name = 'DownloadTooLargeError'
  }
}

/** The session the container named is not one of this agent's browsers. */
export class SessionNotOwnedError extends Error {
  constructor() {
    super("That browser session is not this agent's")
    this.name = 'SessionNotOwnedError'
  }
}

/** Throw unless the session belongs to the agent's context or profile (null: the agent has none). */
export function assertSessionOwned(sessionOwner: string | null | undefined, agentOwner: string | null): void {
  if (!sessionOwner || !agentOwner || sessionOwner !== agentOwner) throw new SessionNotOwnedError()
}

/**
 * Whether a stored file is the download: named by its guid (Browserbase's
 * archive adds a `-<timestamp>` suffix), or by the name a listing gave.
 * Never by the page's name for the file: a file stored under that name came
 * from no download the container asks for by guid (the container's behaviour
 * was not in force), and an older one of the same name would be taken for it.
 * Never `<guid>.crdownload` either: that is Chrome's file while the download
 * is still being written.
 */
export function storedNameMatches(storedName: string, download: BrowserDownloadRef): boolean {
  const base = storedName.split('/').pop() ?? storedName
  if (base === download.guid) return true
  const afterGuid = base.startsWith(download.guid) ? base.slice(download.guid.length) : null
  return afterGuid !== null && /^-\d+$/.test(afterGuid)
}

/** The stored file for a download, by its guid. */
export function findStoredDownload<T>(files: T[], nameOf: (file: T) => string, download: BrowserDownloadRef): T | null {
  return files.find((file) => storedNameMatches(nameOf(file), download)) ?? null
}
