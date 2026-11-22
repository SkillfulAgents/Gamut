/**
 * The official MCP conformance suite against the auth-mode server, through a
 * proxy that adds a real OAuth access token (issued by this deployment to an
 * SDK client the admin approved in the browser), so every scenario passes
 * the resource server's checks. Same pinned versions and baselines as the
 * installation-token run (e2e/mcp/conformance.spec.ts): the tool surface must
 * not change with the credential.
 *
 * The suite's `auth/*` scenarios are client-mode only: they test an MCP
 * client against the suite's own authorization server and cannot be pointed
 * at another one, so this deployment's authorization server is covered by
 * oauth-sdk.spec.ts and the CLI spec instead.
 */
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { baseUrl, mcpUrl, people, setMcpEnabled } from './harness/oauth-app'
import { consentInBrowser } from './harness/browser-consent'
import { connectWithOAuth, MemoryOAuthProvider } from './harness/sdk-oauth'
import { startHeaderProxy, type HeaderProxy } from '../harness/header-proxy'

test.describe.configure({ mode: 'serial' })

const SUITES = [
  { name: '2025-era (2025-06-18, 2025-11-25)', version: '0.1.16', args: ['--suite', 'all'], baseline: 'baseline-2025.yml' },
  { name: '2026-07-28 requirements', version: '0.2.0-alpha.12', args: ['--requirements', '2026-07-28'], baseline: 'baseline-2026-07-28.yml' },
] as const

function run(command: string, args: string[], logFile: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const log = fs.createWriteStream(logFile)
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    child.on('error', reject)
    child.on('close', (code) => {
      log.end()
      resolve(code ?? 1)
    })
  })
}

for (const suite of SUITES) {
  test(`conformance ${suite.version}: ${suite.name}, through a real OAuth access token`, async ({ browser }) => {
    const testInfo = test.info()
    test.setTimeout(15 * 60_000)
    const { admin } = await people()
    await setMcpEnabled(admin, true)
    // A fresh token per suite: access tokens live 15 minutes.
    const provider = new MemoryOAuthProvider(`Conformance ${suite.version}`)
    const session = await connectWithOAuth('v2', mcpUrl(), provider, async (url) => (await consentInBrowser(browser, url.href, admin)).callback)
    await session.close()
    let proxy: HeaderProxy | null = null
    try {
      proxy = await startHeaderProxy(baseUrl(), { Authorization: `Bearer ${provider.accessToken}` })
      const logFile = testInfo.outputPath('conformance.log')
      const code = await run('npx', [
        '-y', `@modelcontextprotocol/conformance@${suite.version}`,
        'server', '--url', `${proxy.origin}/mcp`,
        ...suite.args,
        '--expected-failures', path.resolve(__dirname, '..', 'conformance', suite.baseline),
        '-o', testInfo.outputPath('results'),
      ], logFile)
      const log = fs.readFileSync(logFile, 'utf8')
      await testInfo.attach('conformance.log', { path: logFile, contentType: 'text/plain' })
      expect(log, 'the suite ran scenarios').toMatch(/=== SUMMARY ===/)
      expect(code, `conformance exited ${code}; see conformance.log:\n${log.slice(log.lastIndexOf('=== SUMMARY ==='))}`).toBe(0)
      // Every request went through the OAuth resource server, and none was refused there.
      expect(proxy.seen.filter((request) => request.path.startsWith('/mcp')).length).toBeGreaterThan(0)
      expect(proxy.seen.some((request) => request.status === 401 || request.status === 403)).toBe(false)
    } finally {
      await proxy?.close()
    }
  })
}
