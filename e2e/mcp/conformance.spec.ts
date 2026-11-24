/**
 * The official MCP conformance suite (github.com/modelcontextprotocol/conformance)
 * against the running server, once per protocol generation, each with an
 * expected-failures baseline whose every entry says why (e2e/mcp/conformance/).
 * The suite has no auth option, so it reaches /mcp through a proxy that adds
 * the installation token: the real token check stays in the path.
 */
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { baseUrl, mcpTarget } from './harness/app'
import { startHeaderProxy, type HeaderProxy } from './harness/header-proxy'

test.describe.configure({ mode: 'serial' })

/** Pinned: a new suite release is a deliberate update of the baselines. */
const SUITES = [
  {
    name: '2025-era (2025-06-18, 2025-11-25)',
    version: '0.1.16',
    args: ['--suite', 'all'],
    baseline: 'baseline-2025.yml',
  },
  {
    name: '2026-07-28 requirements',
    version: '0.2.0-alpha.12',
    args: ['--requirements', '2026-07-28'],
    baseline: 'baseline-2026-07-28.yml',
  },
] as const

let proxy: HeaderProxy

test.beforeAll(async () => {
  const { token } = await mcpTarget()
  proxy = await startHeaderProxy(baseUrl(), { Authorization: `Bearer ${token}` })
})

test.afterAll(async () => {
  await proxy?.close()
})

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
  test(`conformance ${suite.version}: ${suite.name}, only baselined failures`, async () => {
    const testInfo = test.info()
    test.setTimeout(15 * 60_000)
    const outDir = testInfo.outputPath('results')
    const logFile = testInfo.outputPath('conformance.log')
    const baseline = path.resolve(__dirname, 'conformance', suite.baseline)
    const code = await run('npx', [
      '-y', `@modelcontextprotocol/conformance@${suite.version}`,
      'server', '--url', `${proxy.origin}/mcp`,
      ...suite.args,
      '--expected-failures', baseline,
      '-o', outDir,
    ], logFile)
    const log = fs.readFileSync(logFile, 'utf8')
    await testInfo.attach('conformance.log', { path: logFile, contentType: 'text/plain' })
    expect(log, 'the suite ran scenarios').toMatch(/=== SUMMARY ===/)
    expect(code, `conformance exited ${code}; see conformance.log:\n${log.slice(log.lastIndexOf('=== SUMMARY ==='))}`).toBe(0)
    // Every request went through the real token check.
    expect(proxy.seen.length).toBeGreaterThan(0)
    expect(proxy.seen.some((request) => request.status === 401)).toBe(false)
  })
}
