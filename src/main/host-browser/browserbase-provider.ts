import {
  getSettings,
  getEffectiveBrowserbaseApiKey,
  effectiveBrowserbaseApiKeyFrom,
  effectiveBrowserbaseProjectIdFrom,
  type AppSettings,
} from '@shared/lib/config/settings'
import { getOrCreateMapping } from './context-map-store'
import { GooglePasskeyRecovery } from './google-passkey-recovery'
import { pageWsUrlFromDebuggerUrl } from './browserbase-live-view'
import { browserbaseSessionState } from './browserbase-session-status'
import { defineLiveSessions, openLiveSession, type RecordedSessionState } from './live-session'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo, BrowserDebugInfo } from './types'

const BROWSERBASE_API_BASE = 'https://api.browserbase.com/v1'

/** Each agent's live session, for every process that serves the tenant (live-session.ts). */
const liveSessions = defineLiveSessions('browserbase')

/** How the container reaches a session. `watchable`: the debug endpoint, which takes more than one connection. */
interface SessionConnection {
  cdpUrl: string
  watchable: boolean
}

interface BrowserbaseSession {
  id: string
  connectUrl: string
  status: string
  keepAlive: boolean
}

interface BrowserbaseDebugResponse {
  wsUrl?: string
  pages?: Array<{
    id: string
    url: string
    debuggerUrl?: string
    debuggerFullscreenUrl?: string
  }>
}

/**
 * The Browserbase account one operation (a detection, a launch, a stop of
 * every session) uses, from one settings read. Not kept past it: the next
 * operation reads again.
 */
interface BrowserbaseCredentials {
  apiKey: string | undefined
  projectId: string | undefined
}

/** Both halves of the account, as a launch or a release needs them. */
interface BrowserbaseAccount {
  apiKey: string
  projectId: string
}

function credentialsFrom(settings: Pick<AppSettings, 'apiKeys'>): BrowserbaseCredentials {
  return { apiKey: effectiveBrowserbaseApiKeyFrom(settings), projectId: effectiveBrowserbaseProjectIdFrom(settings) }
}

export class BrowserbaseProvider implements HostBrowserProvider {
  readonly id = 'browserbase' as const
  readonly name = 'Browserbase'

  /**
   * Maps instanceId → the Browserbase session this process launched or was
   * handed. A hint: the session an instance has is the recorded one
   * (`liveSessions`), which a launch or a stop in another process changes
   * without this map hearing of it.
   */
  private sessions: Map<string, string> = new Map()
  private passkeyRecovery = new GooglePasskeyRecovery()

  onExternalClose: ((instanceId: string) => void) | null = null

  async detect(): Promise<HostBrowserProviderStatus> {
    const { apiKey, projectId } = credentialsFrom(await getSettings())

    if (!apiKey || !projectId) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        reason: !apiKey ? 'API key not configured' : 'Project ID not configured',
      }
    }

    return { id: this.id, name: this.name, available: true }
  }

  async launch(instanceId: string, _options?: Record<string, string>, agentId?: string): Promise<BrowserConnectionInfo> {
    // One read for the account and the stealth / proxy options below.
    const settings = await getSettings()
    const { apiKey, projectId } = credentialsFrom(settings)

    if (!apiKey || !projectId) {
      throw new Error('Browserbase API key and project ID must be configured')
    }
    const account = { apiKey, projectId }

    // The session the agent has, whichever process opened it; a new one only when it has none that runs.
    const { sessionId, connection, reused } = await openLiveSession<SessionConnection>(liveSessions, instanceId, {
      connect: (recorded) => this.connectTo(recorded, apiKey),
      create: () => this.createSession(instanceId, agentId || instanceId, settings, account),
      release: (unused) => this.release(unused, account),
    })
    this.sessions.set(instanceId, sessionId)
    if (reused) console.log(`[BrowserbaseProvider] Reusing session ${sessionId} for instance ${instanceId}`)

    // The observer of an earlier session goes before its replacement's is started.
    if (!reused) this.passkeyRecovery.stop(instanceId)
    if (connection.watchable) this.passkeyRecovery.watch(instanceId, connection.cdpUrl)
    return { cdpUrl: connection.cdpUrl }
  }

  /** A recorded session while it runs: a fresh debug browser URL for the CDP connection. */
  private async connectTo(sessionId: string, apiKey: string): Promise<RecordedSessionState<SessionConnection>> {
    let status: string
    try {
      status = (await this.fetchSession(sessionId, apiKey)).status
    } catch {
      return { state: 'unknown' }
    }
    const state = browserbaseSessionState(status)
    if (state !== 'running') return { state }
    const debugUrl = await this.getDebugBrowserUrl(sessionId, apiKey)
    return debugUrl ? { state: 'running', connection: { cdpUrl: debugUrl, watchable: true } } : { state: 'unknown' }
  }

  /** A new session on the agent's context, with keepAlive so it survives agent-browser disconnecting. */
  private async createSession(
    instanceId: string,
    contextKey: string,
    settings: Pick<AppSettings, 'app'>,
    { apiKey, projectId }: BrowserbaseAccount,
  ): Promise<{ sessionId: string; connection: SessionConnection }> {
    // Get or create a persistent context for this agent (preserves cookies/storage across sessions)
    const contextId = await this.getOrCreateContext(contextKey, projectId, apiKey)

    // Build session creation payload with optional stealth & proxy settings
    const browserSettings: Record<string, unknown> = {
      context: { id: contextId, persist: true },
    }

    // Advanced Stealth Mode
    if (settings.app?.browserbaseAdvancedStealth) {
      browserSettings.advancedStealth = true
      if (settings.app.browserbaseStealthOs) {
        browserSettings.os = settings.app.browserbaseStealthOs
      }
    }

    const sessionPayload: Record<string, unknown> = { projectId, keepAlive: true, browserSettings }

    // Proxy configuration
    if (settings.app?.browserbaseProxies) {
      const { browserbaseProxyCountry, browserbaseProxyCity, browserbaseProxyState } = settings.app
      if (browserbaseProxyCountry || browserbaseProxyCity || browserbaseProxyState) {
        // Geolocation proxy
        const geolocation: Record<string, string> = {}
        if (browserbaseProxyCountry) geolocation.country = browserbaseProxyCountry
        if (browserbaseProxyState) geolocation.state = browserbaseProxyState
        if (browserbaseProxyCity) geolocation.city = browserbaseProxyCity
        sessionPayload.proxies = [{ type: 'browserbase', geolocation }]
      } else {
        // Simple built-in proxy (best-effort US)
        sessionPayload.proxies = true
      }
    }

    const response = await fetch(`${BROWSERBASE_API_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BB-API-Key': apiKey,
      },
      body: JSON.stringify(sessionPayload),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to create Browserbase session: ${response.status} ${body}`)
    }

    const session = await response.json() as BrowserbaseSession
    console.log(`[BrowserbaseProvider] Created session ${session.id} for instance ${instanceId} (keepAlive: ${session.keepAlive})`)

    // Use the debug browser URL as the CDP endpoint (supports multiple connections,
    // unlike the connectUrl which is single-use)
    const debugUrl = await this.getDebugBrowserUrl(session.id, apiKey)
    // Fallback to connectUrl (single-use, but better than nothing)
    return { sessionId: session.id, connection: debugUrl ? { cdpUrl: debugUrl, watchable: true } : { cdpUrl: session.connectUrl, watchable: false } }
  }

  async getDebugInfo(instanceId: string): Promise<BrowserDebugInfo | null> {
    const sessionId = await this.sessionOf(instanceId)
    if (!sessionId) return null

    const apiKey = await getEffectiveBrowserbaseApiKey()
    if (!apiKey) return null

    const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}/debug`, {
      headers: { 'X-BB-API-Key': apiKey },
    })

    if (!response.ok) {
      console.error(`[BrowserbaseProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
      return null
    }

    const debug = await response.json() as BrowserbaseDebugResponse
    if (!debug.pages || debug.pages.length === 0) return null

    const pages = debug.pages.flatMap((page) => {
      const wsUrl = pageWsUrlFromDebuggerUrl(page.debuggerUrl)
      return wsUrl ? [{ id: page.id, url: page.url, wsUrl }] : []
    })

    return { pages }
  }

  /** The instance's session: the recorded one, or this process's own when the record cannot be read. */
  private async sessionOf(instanceId: string): Promise<string | null> {
    try {
      return (await liveSessions.read(instanceId))?.sessionId ?? null
    } catch (error) {
      console.error(`[BrowserbaseProvider] Could not read the recorded session of ${instanceId}:`, error)
      return this.sessions.get(instanceId) ?? null
    }
  }

  /**
   * Stop the instance's browser, whichever process opened it: the recorded
   * session is taken and released, so of several stops one releases it.
   */
  async stop(instanceId: string): Promise<void> {
    return this.stopWith(instanceId)
  }

  /** Stop one session, with the account `stopAll` read for every session, else one read now. `ownOnly`: only the session this process holds. */
  private async stopWith(instanceId: string, credentials?: BrowserbaseCredentials, ownOnly = false): Promise<void> {
    this.passkeyRecovery.stop(instanceId)
    const own = this.sessions.get(instanceId)
    this.sessions.delete(instanceId)

    const { apiKey, projectId } = credentials ?? credentialsFrom(await getSettings())
    // Without the account nothing can be released, so the record stays: the
    // next launch uses the session, or a stop that has the account releases it.
    if (!apiKey || !projectId) return

    let sessionId: string | null
    try {
      sessionId = ownOnly ? (own ? await liveSessions.take(instanceId, own) : null) : await liveSessions.take(instanceId)
    } catch (error) {
      // What this process opened can still be released.
      console.error(`[BrowserbaseProvider] Could not take the recorded session of ${instanceId}:`, error)
      sessionId = own ?? null
    }
    if (!sessionId) return

    if ((await this.release(sessionId, { apiKey, projectId })) === 'failed') {
      // Still running: recorded again, so the next launch uses it and the next stop releases it.
      await liveSessions.restore(instanceId, sessionId).catch(() => {})
    }
  }

  /**
   * Asks Browserbase to end a session, and never throws. `failed`: the request
   * did not get through (no answer, a 5xx, a 429), so the session may run on
   * and another try may work; `refused`: any other answer, which another try
   * would get again.
   */
  private async release(sessionId: string, { apiKey, projectId }: BrowserbaseAccount): Promise<'released' | 'refused' | 'failed'> {
    try {
      const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BB-API-Key': apiKey,
        },
        body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
      })
      if (response.ok) {
        console.log(`[BrowserbaseProvider] Released session ${sessionId}`)
        return 'released'
      }
      console.error(`[BrowserbaseProvider] Releasing session ${sessionId} was answered ${response.status}`)
      return response.status >= 500 || response.status === 429 ? 'failed' : 'refused'
    } catch (error) {
      console.error(`[BrowserbaseProvider] Error releasing session ${sessionId}:`, error)
      return 'failed'
    }
  }

  /**
   * Stops the sessions this process holds, the browsers it opened or was
   * handed, while each is still its agent's: one another process replaced
   * since is that process's to stop.
   */
  async stopAll(): Promise<void> {
    const instanceIds = Array.from(this.sessions.keys())
    if (instanceIds.length === 0) return
    // One read for the whole batch.
    const credentials = credentialsFrom(await getSettings())
    await Promise.all(instanceIds.map((id) => this.stopWith(id, credentials, true)))
  }

  /**
   * Whether this process holds a session for the instance (or any). A browser
   * another process opened is not seen here; `stop` finds it all the same.
   */
  isRunning(instanceId?: string): boolean {
    if (instanceId) {
      return this.sessions.has(instanceId)
    }
    return this.sessions.size > 0
  }


  /** Get or create a Browserbase context for the given instance */
  private async getOrCreateContext(instanceId: string, projectId: string, apiKey: string): Promise<string> {
    // getOrCreateMapping dedups concurrent first-opens for the same instance so
    // we never create (and then orphan/leak) two paid contexts; it re-reads the
    // mapping and commits it with insert-if-absent.
    return getOrCreateMapping('browserbase', instanceId, async () => {
      const response = await fetch(`${BROWSERBASE_API_BASE}/contexts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BB-API-Key': apiKey,
        },
        body: JSON.stringify({ projectId }),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Failed to create Browserbase context: ${response.status} ${body}`)
      }

      const context = await response.json() as { id: string }
      console.log(`[BrowserbaseProvider] Created context ${context.id} for instance ${instanceId}`)
      return context.id
    })
  }

  /** Get the debug browser-level WebSocket URL for a session */
  private async getDebugBrowserUrl(sessionId: string, apiKey: string): Promise<string | null> {
    try {
      const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}/debug`, {
        headers: { 'X-BB-API-Key': apiKey },
      })

      if (!response.ok) {
        console.error(`[BrowserbaseProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
        return null
      }

      const debug = await response.json() as BrowserbaseDebugResponse
      return debug.wsUrl || null
    } catch (err) {
      console.error('[BrowserbaseProvider] Failed to get debug URL:', err)
      return null
    }
  }

  private async fetchSession(sessionId: string, apiKey: string): Promise<BrowserbaseSession> {
    const response = await fetch(`${BROWSERBASE_API_BASE}/sessions/${sessionId}`, {
      headers: { 'X-BB-API-Key': apiKey },
    })

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status}`)
    }

    return response.json() as Promise<BrowserbaseSession>
  }
}
