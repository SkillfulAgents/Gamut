/**
 * LIVE: click-started downloads in a real Browserbase or Steel browser reach
 * the agent's downloads folder, through every real piece: the provider opens
 * the session, the container's download watcher holds the browser
 * connection, the page saves files, the watcher asks the real
 * `/api/browser/downloads` and `/api/browser/download-file` routes over HTTP,
 * and the provider reads its copy.
 *
 * The routes are served by a provider instance other than the one that
 * launched the browser, with nothing in memory (a Cloudflare isolate): the
 * session is the one the container names, checked against the agent's
 * mapping. Covered: a generated key, a blob export, an attachment, two files
 * with one name, a Playwright connection coming and going, the watcher's
 * socket dropping (caught up on reconnect), a close right after a download,
 * and another agent asking for this agent's session.
 *
 * Opens one paid session per provider (released at the end). Skipped unless
 * a key is set:
 *
 *   BROWSERBASE_LIVE_API_KEY=bb_live_… STEEL_LIVE_API_KEY=ste-… npx vitest run src/main/host-browser/cloud-downloads.live.test.ts
 *
 * (BROWSERBASE_LIVE_PROJECT_ID picks the project; else the key's first.)
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const BROWSERBASE_KEY = process.env.BROWSERBASE_LIVE_API_KEY
const STEEL_KEY = process.env.STEEL_LIVE_API_KEY
const h = vi.hoisted(() => ({ browserbaseProjectId: '', mappings: new Map<string, string>() }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => ({ apiKeys: { steelApiKey: process.env.STEEL_LIVE_API_KEY }, app: {} }),
  getEffectiveBrowserbaseApiKey: async () => process.env.BROWSERBASE_LIVE_API_KEY,
  effectiveBrowserbaseApiKeyFrom: () => process.env.BROWSERBASE_LIVE_API_KEY,
  effectiveBrowserbaseProjectIdFrom: () => h.browserbaseProjectId,
  effectiveSteelApiKeyFrom: () => process.env.STEEL_LIVE_API_KEY,
}))
// The database's mapping, shared by every provider instance, as the real one is.
vi.mock('./context-map-store', () => ({
  readContextMapping: async (provider: string, key: string) => h.mappings.get(`${provider}:${key}`) ?? null,
  getOrCreateMapping: async (provider: string, key: string, create: () => Promise<string>) => {
    const k = `${provider}:${key}`
    if (!h.mappings.has(k)) h.mappings.set(k, await create())
    return h.mappings.get(k)!
  },
  replaceContextMapping: async (provider: string, key: string, _stale: string, next: string) => {
    h.mappings.set(`${provider}:${key}`, next)
    return next
  },
}))
vi.mock('./google-passkey-recovery', () => ({ GooglePasskeyRecovery: class { watch() {} stop() {} } }))

// The routes, with the real IsAgent() resolving each container's token to its agent.
const providerRef: { current: unknown } = { current: null }
vi.mock('../../main/host-browser', () => ({
  getActiveProvider: async () => providerRef.current,
  setOnExternalClose: () => {},
}))
vi.mock('@shared/lib/proxy/token-store', () => ({
  validateProxyToken: async (token: string) => ({ 'tok-a': 'agent-a', 'tok-b': 'agent-b' } as Record<string, string>)[token] ?? null,
}))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return { containerHost: hostFromManagerMock({ getClient: () => ({ fetch: vi.fn() }) }) }
})
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/platform-attribution', () => ({
  runWithRequestUser: (_id: string, fn: () => unknown) => fn(),
  runWithOptionalUser: (_id: string | null | undefined, fn: () => unknown) => fn(),
}))
vi.mock('@shared/lib/db', () => ({ db: {} }))
vi.mock('@shared/lib/db/schema', () => ({ agentAcl: {}, connectedAccounts: {}, remoteMcpServers: {}, notifications: {} }))

import { Hono } from 'hono'
import { serve, type ServerType } from '@hono/node-server'
import browserRoutes from '../../api/routes/browser'
import { BrowserbaseProvider } from './browserbase-provider'
import { SteelProvider } from './steel-provider'
import type { HostBrowserProvider } from './types'
import { CdpConnection } from '../../../agent-container/src/login-cdp'
import { DownloadWatcher, hostDownloads, type DownloadReport } from '../../../agent-container/src/download-watcher'

const BROWSERBASE_API = 'https://api.browserbase.com/v1'

/** Save `content` from the page as `name`, the way a page's "Export" button does. */
const saveScript = (href: string, name?: string) =>
  `(() => { const a = document.createElement('a'); a.href = ${href}; ${name ? `a.download = ${JSON.stringify(name)};` : ''} document.body.appendChild(a); a.click(); a.remove(); return 1 })()`

const providers = [
  { name: 'Browserbase', key: BROWSERBASE_KEY, create: () => new BrowserbaseProvider() as HostBrowserProvider },
  { name: 'Steel', key: STEEL_KEY, create: () => new SteelProvider() as HostBrowserProvider },
]

for (const { name, key, create } of providers) {
  describe.skipIf(!key)(`${name}: click downloads reach the workspace (live)`, () => {
    let server: ServerType
    let hostUrl: string
    let launcher: HostBrowserProvider
    let cdpUrl: string
    let sessionId: string
    let dir: string
    let watcher: DownloadWatcher
    /** The watcher's live socket, to drop it as a network blip would. */
    let watcherSocket: CdpConnection | null = null
    let driver: CdpConnection
    let page: string

    const inPage = (expression: string) => driver.send('Runtime.evaluate', { expression, awaitPromise: true }, page)
    const content = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8')
    /** Reports until `count` have finished (one still under way is named again once done). */
    async function finished(since: number, count: number, timeoutMs = 60_000): Promise<DownloadReport[]> {
      const reports: DownloadReport[] = []
      const deadline = Date.now() + timeoutMs
      while (reports.length < count && Date.now() < deadline) {
        reports.push(...(await watcher.report(since, 20_000)).filter((r) => !r.inProgress))
        if (reports.length < count) await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return reports
    }

    beforeAll(async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      if (name === 'Browserbase') {
        h.browserbaseProjectId = process.env.BROWSERBASE_LIVE_PROJECT_ID
          ?? ((await (await fetch(`${BROWSERBASE_API}/projects`, { headers: { 'X-BB-API-Key': key! } })).json()) as Array<{ id: string }>)[0].id
      }

      const app = new Hono()
      app.route('/api/browser', browserRoutes)
      server = serve({ fetch: app.fetch, port: 0 })
      await new Promise((resolve) => server.once('listening', resolve))
      hostUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      launcher = create()
      const launched = await launcher.launch('agent-a', {}, 'agent-a')
      cdpUrl = launched.cdpUrl!
      sessionId = launched.sessionId!
      expect(sessionId).toBeTruthy()
      // The routes are answered by another instance, which kept nothing from the launch.
      providerRef.current = create()

      dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name.toLowerCase()}-live-downloads-`))
      watcher = new DownloadWatcher({
        connectBrowser: async () => (watcherSocket = await CdpConnection.openBrowser(cdpUrl, { callTimeoutMs: 15_000 })),
        host: hostDownloads(sessionId, { HOST_APP_URL: hostUrl, PROXY_TOKEN: 'tok-a', AGENT_ID: 'agent-a' }),
        downloadsDir: dir,
      })
      watcher.start()
      await watcher.ensure()

      // agent-browser's part: its own connection, driving the tab.
      driver = await CdpConnection.openBrowser(cdpUrl, { callTimeoutMs: 30_000 })
      const { targetInfos } = await driver.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets')
      const target = targetInfos.find((t) => t.type === 'page')
        ?? { targetId: (await driver.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' })).targetId }
      page = (await driver.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
      await driver.send('Page.enable', {}, page)
      await driver.send('Page.navigate', { url: 'https://example.com/' }, page)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    }, 180_000)

    afterAll(async () => {
      driver?.close()
      await watcher?.close()
      await launcher?.stop('agent-a')
      await new Promise((resolve) => server?.close(resolve))
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
      // What the run created on the account: the agent's context or profile.
      const owner = h.mappings.get(`${name === 'Steel' ? 'steel' : 'browserbase'}:agent-a`)
      if (owner && name === 'Browserbase') await fetch(`${BROWSERBASE_API}/contexts/${owner}`, { method: 'DELETE', headers: { 'X-BB-API-Key': key! } }).catch(() => {})
      if (owner && name === 'Steel') {
        await new Promise((resolve) => setTimeout(resolve, 5_000)) // Steel saves the profile after release
        await fetch(`https://api.steel.dev/v1/profiles/${owner}`, { method: 'DELETE', headers: { 'steel-api-key': key! } }).catch(() => {})
      }
    }, 60_000)

    it('saves a generated key, a blob export and an attachment under their own names', async () => {
      const since = Date.now()
      await inPage(saveScript(`'data:application/json;base64,' + btoa('{"type":"service_account","project_id":"seo-agent-516019"}')`, 'seo-agent-516019-aaf0252f7bad.json'))
      await inPage(saveScript(`URL.createObjectURL(new Blob(['keyword,volume\\nseo agent,1200\\n'], { type: 'text/csv' }))`, 'keywords-report.csv'))
      await inPage(saveScript(`'https://httpbin.org/response-headers?Content-Type=text/plain&Content-Disposition=attachment%3B%20filename%3D%22notes.txt%22'`))
      const reports = await finished(since, 3)
      expect(reports.map((r) => r.suggestedFilename).sort()).toEqual(['keywords-report.csv', 'notes.txt', 'seo-agent-516019-aaf0252f7bad.json'])
      for (const report of reports) expect(report.failed).toBeUndefined()
      expect(content('seo-agent-516019-aaf0252f7bad.json')).toBe('{"type":"service_account","project_id":"seo-agent-516019"}')
      expect(content('keywords-report.csv')).toBe('keyword,volume\nseo agent,1200\n')
      expect(content('notes.txt')).toContain('attachment; filename=\\"notes.txt\\"')
    }, 120_000)

    it('keeps both of two downloads with one name, each with its own bytes', async () => {
      const since = Date.now()
      await inPage(saveScript(`'data:text/plain,first'`, 'twin.txt'))
      await inPage(saveScript(`'data:text/plain,second'`, 'twin.txt'))
      const reports = await finished(since, 2)
      expect(reports.map((r) => r.saved?.path).sort()).toEqual([path.join(dir, 'twin-1.txt'), path.join(dir, 'twin.txt')])
      expect([content('twin.txt'), content('twin-1.txt')].sort()).toEqual(['first', 'second'])
    }, 120_000)

    it('still saves downloads after a Playwright connection came and went', async () => {
      const { chromium } = await import('playwright-core')
      const pw = await chromium.connectOverCDP(cdpUrl)
      await pw.close()
      await watcher.reapply()
      const since = Date.now()
      await inPage(saveScript(`'data:text/plain,after%20playwright'`, 'after.txt'))
      expect(await finished(since, 1)).toEqual([{ suggestedFilename: 'after.txt', saved: { path: path.join(dir, 'after.txt'), size: 16 } }])
    }, 120_000)

    it('after its socket dropped, catches up on what the browser downloaded meanwhile', async () => {
      watcherSocket!.close()
      await inPage(saveScript(`'data:text/plain,while%20nobody%20listened'`, 'unheard.txt'))
      await new Promise((resolve) => setTimeout(resolve, 6_000)) // the provider stores it meanwhile
      const before = new Set(fs.readdirSync(dir))
      await watcher.ensure()
      let caught: string | undefined
      const deadline = Date.now() + 30_000
      while (!caught && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        caught = fs.readdirSync(dir).find((file) => !before.has(file))
      }
      expect(caught).toBeTruthy()
      expect(content(caught!)).toBe('while nobody listened')
      // Named once, by the provider's name for it (the page's name came by no event).
      const [report] = await watcher.report(Date.now(), 1_000)
      expect(report).toMatchObject({ suggestedFilename: caught, saved: { path: path.join(dir, caught!), size: 21 } })
      // And downloads after the reconnect are heard again, under the page's name.
      const since = Date.now()
      await inPage(saveScript(`'data:text/plain,heard%20again'`, 'heard-again.txt'))
      expect((await finished(since, 1))[0].saved?.path).toBe(path.join(dir, 'heard-again.txt'))
    }, 120_000)

    it("refuses this agent's session to another agent's container", async () => {
      for (const route of ['downloads', 'download-file']) {
        const res = await fetch(`${hostUrl}/api/browser/${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-b' },
          body: JSON.stringify({ sessionId, guid: 'anything' }),
        })
        expect(res.status).toBe(403)
      }
    }, 60_000)

    it('lands a download made just before the browser closes', async () => {
      await inPage(saveScript(`URL.createObjectURL(new Blob(['last one'], { type: 'text/plain' }))`, 'last.txt'))
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      const reports = await watcher.close(30_000)
      expect(reports.filter((r) => r.saved).map((r) => r.suggestedFilename)).toContain('last.txt')
      expect(content('last.txt')).toBe('last one')
    }, 120_000)
  })
}
