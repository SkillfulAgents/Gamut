import { getSettings, type AppSettings } from '@shared/lib/config/settings'
import { getPlatformAccessToken, platformAccessTokenFrom } from '@shared/lib/services/platform-auth-service'
import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { getOrCreateMapping } from './context-map-store'
import { GooglePasskeyRecovery } from './google-passkey-recovery'
import { pageWsUrlFromDebuggerUrl } from './browserbase-live-view'
import { browserbaseSessionState } from './browserbase-session-status'
import { defineLiveSessions, openLiveSession, type RecordedSessionState } from './live-session'
import type { HostBrowserProvider, HostBrowserProviderStatus, BrowserConnectionInfo, BrowserDebugInfo } from './types'


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

/** Each agent's live session, for every process that serves the tenant (live-session.ts). */
const liveSessions = defineLiveSessions('platform')

/** How the container reaches a session. `watchable`: the debug endpoint, which takes more than one connection. */
interface SessionConnection {
  cdpUrl: string
  watchable: boolean
}

export class PlatformBrowserProvider implements HostBrowserProvider {
  readonly id = 'platform' as const
  readonly name = 'Platform'

  /**
   * Maps instanceId → the Browserbase session (proxied through platform) this
   * process launched or was handed. A hint: the session an instance has is the
   * recorded one (`liveSessions`), which a launch or a stop in another process
   * changes without this map hearing of it.
   */
  private sessions: Map<string, string> = new Map()
  private passkeyRecovery = new GooglePasskeyRecovery()

  onExternalClose: ((instanceId: string) => void) | null = null

  async detect(): Promise<HostBrowserProviderStatus> {
    if (!getPlatformProxyBaseUrl()) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        reason: 'proxy URL not configured',
      }
    }
    if (!(await getPlatformAccessToken())) {
      return {
        id: this.id,
        name: this.name,
        available: false,
        reason: 'sign in required',
      }
    }
    return { id: this.id, name: this.name, available: true }
  }

  async launch(instanceId: string, _options?: Record<string, string>, agentId?: string): Promise<BrowserConnectionInfo> {
    // One read for the token and the stealth / proxy options below.
    const settings = await getSettings()
    const token = platformAccessTokenFrom(settings)
    if (!token) {
      throw new Error('Not signed in to Platform — cannot use platform-managed Browserbase')
    }

    // The session the agent has, whichever process opened it; a new one only when it has none that runs.
    const { sessionId, connection, reused } = await openLiveSession<SessionConnection>(liveSessions, instanceId, {
      connect: (recorded) => this.connectTo(recorded, token),
      create: () => this.createSession(instanceId, agentId || instanceId, settings, token),
      release: (unused) => this.release(unused, token),
    })
    this.sessions.set(instanceId, sessionId)
    if (reused) console.log(`[PlatformBrowserProvider] Reusing session ${sessionId} for instance ${instanceId}`)

    // The observer of an earlier session goes before its replacement's is started.
    if (!reused) this.passkeyRecovery.stop(instanceId)
    if (connection.watchable) this.passkeyRecovery.watch(instanceId, connection.cdpUrl)
    return { cdpUrl: connection.cdpUrl }
  }

  /** A recorded session while it runs: a fresh debug browser URL for the CDP connection. */
  private async connectTo(sessionId: string, token: string): Promise<RecordedSessionState<SessionConnection>> {
    let status: string
    try {
      status = (await this.fetchSession(sessionId, token)).status
    } catch {
      return { state: 'unknown' }
    }
    const state = browserbaseSessionState(status)
    if (state !== 'running') return { state }
    const debugUrl = await this.getDebugBrowserUrl(sessionId, token)
    return debugUrl ? { state: 'running', connection: { cdpUrl: debugUrl, watchable: true } } : { state: 'unknown' }
  }

  /** A new session on the agent's context, with keepAlive so it survives agent-browser disconnecting. */
  private async createSession(
    instanceId: string,
    contextKey: string,
    settings: Pick<AppSettings, 'app'>,
    token: string,
  ): Promise<{ sessionId: string; connection: SessionConnection }> {
    const contextId = await this.getOrCreateContext(contextKey, token)

    const browserSettings: Record<string, unknown> = {
      context: { id: contextId, persist: true },
    }

    if (settings.app?.browserbaseAdvancedStealth) {
      browserSettings.advancedStealth = true
      if (settings.app.browserbaseStealthOs) {
        browserSettings.os = settings.app.browserbaseStealthOs
      }
    }

    const sessionPayload: Record<string, unknown> = { keepAlive: true, browserSettings }

    if (settings.app?.browserbaseProxies) {
      const { browserbaseProxyCountry, browserbaseProxyCity, browserbaseProxyState } = settings.app
      if (browserbaseProxyCountry || browserbaseProxyCity || browserbaseProxyState) {
        const geolocation: Record<string, string> = {}
        if (browserbaseProxyCountry) geolocation.country = browserbaseProxyCountry
        if (browserbaseProxyState) geolocation.state = browserbaseProxyState
        if (browserbaseProxyCity) geolocation.city = browserbaseProxyCity
        sessionPayload.proxies = [{ type: 'browserbase', geolocation }]
      } else {
        sessionPayload.proxies = true
      }
    }

    const response = await fetch(`${this.proxyBase()}/sessions`, {
      method: 'POST',
      headers: this.authHeaders(token, true),
      body: JSON.stringify(sessionPayload),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to create platform Browserbase session: ${response.status} ${body}`)
    }

    const session = await response.json() as BrowserbaseSession
    console.log(`[PlatformBrowserProvider] Created session ${session.id} for instance ${instanceId} (keepAlive: ${session.keepAlive})`)

    // The debug browser URL takes more than one connection; the connectUrl is single-use.
    const debugUrl = await this.getDebugBrowserUrl(session.id, token)
    return { sessionId: session.id, connection: debugUrl ? { cdpUrl: debugUrl, watchable: true } : { cdpUrl: session.connectUrl, watchable: false } }
  }

  async getDebugInfo(instanceId: string): Promise<BrowserDebugInfo | null> {
    const sessionId = await this.sessionOf(instanceId)
    if (!sessionId) return null

    const token = await getPlatformAccessToken()
    if (!token) return null

    const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}/debug`, {
      headers: this.authHeaders(token),
    })

    if (!response.ok) {
      console.error(`[PlatformBrowserProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
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
      console.error(`[PlatformBrowserProvider] Could not read the recorded session of ${instanceId}:`, error)
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

  /** Stop one session, with the token `stopAll` read for every session, else one read now. `ownOnly`: only the session this process holds. */
  private async stopWith(instanceId: string, token?: string | null, ownOnly = false): Promise<void> {
    this.passkeyRecovery.stop(instanceId)
    const own = this.sessions.get(instanceId)
    this.sessions.delete(instanceId)

    if (token === undefined) token = await getPlatformAccessToken()
    // Signed out, nothing can be released, so the record stays: the next
    // launch uses the session, or a stop that is signed in releases it.
    if (!token) return

    let sessionId: string | null
    try {
      sessionId = ownOnly ? (own ? await liveSessions.take(instanceId, own) : null) : await liveSessions.take(instanceId)
    } catch (error) {
      // What this process opened can still be released.
      console.error(`[PlatformBrowserProvider] Could not take the recorded session of ${instanceId}:`, error)
      sessionId = own ?? null
    }
    if (!sessionId) return

    if ((await this.release(sessionId, token)) === 'failed') {
      // Still running: recorded again, so the next launch uses it and the next stop releases it.
      await liveSessions.restore(instanceId, sessionId).catch(() => {})
    }
  }

  /**
   * Asks the platform to end a session, and never throws. `failed`: the
   * request did not get through (no answer, a 5xx, a 429), so the session may
   * run on and another try may work; `refused`: any other answer, which
   * another try would get again.
   */
  private async release(sessionId: string, token: string): Promise<'released' | 'refused' | 'failed'> {
    try {
      const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}`, {
        method: 'POST',
        headers: this.authHeaders(token, true),
        body: JSON.stringify({ status: 'REQUEST_RELEASE' }),
      })
      if (response.ok) {
        console.log(`[PlatformBrowserProvider] Released session ${sessionId}`)
        return 'released'
      }
      console.error(`[PlatformBrowserProvider] Releasing session ${sessionId} was answered ${response.status}`)
      return response.status >= 500 || response.status === 429 ? 'failed' : 'refused'
    } catch (error) {
      console.error(`[PlatformBrowserProvider] Error releasing session ${sessionId}:`, error)
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
    const token = await getPlatformAccessToken()
    await Promise.all(instanceIds.map((id) => this.stopWith(id, token, true)))
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

  private proxyBase(): string {
    const base = getPlatformProxyBaseUrl()
    if (!base) {
      throw new Error('Platform proxy URL is not configured')
    }
    return `${base}/v1/browserbase`
  }

  private authHeaders(token: string, json = false): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    if (json) headers['Content-Type'] = 'application/json'
    return headers
  }


  private async getOrCreateContext(contextKey: string, token: string): Promise<string> {
    // getOrCreateMapping dedups concurrent first-opens for the same key so we
    // never create (and then orphan/leak) two paid contexts; it re-reads the mapping
    // and commits it with insert-if-absent.
    return getOrCreateMapping('platform', contextKey, async () => {
      const response = await fetch(`${this.proxyBase()}/contexts`, {
        method: 'POST',
        headers: this.authHeaders(token, true),
        body: JSON.stringify({}),
      })

      if (!response.ok) {
        const body = await response.text()
        throw new Error(`Failed to create platform Browserbase context: ${response.status} ${body}`)
      }

      const context = await response.json() as { id: string }
      console.log(`[PlatformBrowserProvider] Created context ${context.id} for ${contextKey}`)
      return context.id
    })
  }

  private async getDebugBrowserUrl(sessionId: string, token: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}/debug`, {
        headers: this.authHeaders(token),
      })

      if (!response.ok) {
        console.error(`[PlatformBrowserProvider] Debug endpoint returned ${response.status} for session ${sessionId}`)
        return null
      }

      const debug = await response.json() as BrowserbaseDebugResponse
      return debug.wsUrl || null
    } catch (err) {
      console.error('[PlatformBrowserProvider] Failed to get debug URL:', err)
      return null
    }
  }

  private async fetchSession(sessionId: string, token: string): Promise<BrowserbaseSession> {
    const response = await fetch(`${this.proxyBase()}/sessions/${sessionId}`, {
      headers: this.authHeaders(token),
    })

    if (!response.ok) {
      throw new Error(`Failed to get session: ${response.status}`)
    }

    return response.json() as Promise<BrowserbaseSession>
  }
}
