export type HostBrowserProviderId = 'chrome' | 'browserbase' | 'platform' | 'steel' | 'tabtender'

export interface BrowserConnectionInfo {
  /** Full CDP WebSocket URL (for remote providers like Browserbase and Steel) */
  cdpUrl?: string
  /** Local CDP port (for local providers like Chrome — container resolves to CDP URL) */
  port?: number
  /**
   * The provider's id for this browser session (cloud providers). The
   * container names it when it asks for the session's downloads: any process
   * can then answer, with nothing kept in memory between requests.
   */
  sessionId?: string
}

/**
 * A download the browser made: by the CDP download's guid (the container sets
 * `allowAndName`, so the browser saves the file under it), or by the name a
 * listing gave (`StoredDownload.name`).
 */
export interface BrowserDownloadRef {
  guid: string
}

/** A file a cloud browser downloaded, as the provider keeps it. */
export interface StoredDownload {
  /** Its name in the provider's storage: the download's guid, or the page's name. */
  name: string
  size: number | null
}

/** Debug info for screencast — page-level CDP URLs for direct connection */
export interface BrowserDebugInfo {
  /** Page-level WebSocket URLs keyed by page ID */
  pages: Array<{ id: string; url: string; wsUrl: string }>
}

export interface HostBrowserProviderStatus {
  id: HostBrowserProviderId
  name: string
  available: boolean
  reason?: string
}

export interface HostBrowserProvider {
  readonly id: HostBrowserProviderId
  readonly name: string

  /** Check if this provider is available (Chrome installed? API key configured?) */
  detect(): Promise<HostBrowserProviderStatus>

  /** Launch/connect a browser instance. Returns CDP connection info. */
  launch(instanceId: string, options?: Record<string, string>, agentId?: string): Promise<BrowserConnectionInfo>

  /** Get debug/screencast connection info for an active instance (optional — for remote providers) */
  getDebugInfo?(instanceId: string): Promise<BrowserDebugInfo | null>

  /**
   * The downloads of one of the agent's browser sessions, and one of them by
   * guid or name: a cloud browser saves downloads on the provider's machine,
   * which the container cannot see. Stateless: the session is the one the
   * container names, checked to be this agent's (SessionNotOwnedError), so a
   * process other than the one that launched it can answer. A read answers
   * null while the provider does not have the file (yet). Both throw
   * DownloadsUnsupportedError when the provider never will. Absent for a
   * browser that saves into the agent's workspace itself (Chrome here).
   */
  listDownloads?(agentId: string, sessionId: string): Promise<StoredDownload[]>
  readDownload?(agentId: string, sessionId: string, download: BrowserDownloadRef): Promise<Buffer | null>

  /** Stop a browser instance */
  stop(instanceId: string): Promise<void>

  /** Stop all instances */
  stopAll(): Promise<void>

  /** Check if a browser instance is running */
  isRunning(instanceId?: string): boolean

  /** Callback when a browser instance closes externally (e.g. user closed Chrome) */
  onExternalClose: ((instanceId: string) => void) | null
}
