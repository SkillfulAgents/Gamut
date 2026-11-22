import { defineConfig } from '@playwright/test'
import path from 'node:path'

// The MCP server suite (e2e/mcp): a real server on its own data dir, driven
// over HTTP by the official MCP client SDKs, the MCP conformance suite and the
// real Claude Code / Codex binaries. Its own server because it switches the
// MCP server off and regenerates the installation token mid-run.
const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data/mcp'))
process.env.SUPERAGENT_DATA_DIR = dataDir
const port = process.env.E2E_PORT ?? process.env.PORT ?? '3014'
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
process.env.E2E_BASE_URL = baseURL
const env = { SUPERAGENT_DATA_DIR: dataDir, E2E_MOCK: 'true', PORT: port, VITE_CACHE_DIR: path.join(dataDir, '.vite') }
const inline = Object.entries(env).map(([name, value]) => process.platform === 'win32'
  ? `set "${name}=${value}"`
  : `${name}="${value}"`).join(process.platform === 'win32' ? ' && ' : ' ')
const command = process.platform === 'win32'
  ? `${inline} && node e2e/setup-e2e-data.js && npm run dev:web`
  : `${inline} node e2e/setup-e2e-data.js && ${inline} npm run dev:web`

export default defineConfig({
  testDir: './e2e/mcp',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/mcp',
  // One server, whose switch and token the specs change: one test at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/mcp' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'mcp' }],
  webServer: { command, url: `${baseURL}/api/settings`, reuseExistingServer: false, timeout: 180_000, stdout: 'pipe' },
})
