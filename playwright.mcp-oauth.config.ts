import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

// The MCP server in an auth-mode deployment (e2e/mcp/oauth): a real auth-mode
// server on its own data dir, signed in to over real HTTP by the official MCP
// SDKs' OAuth support, the MCP conformance suite with a real access token, and
// the real Claude Code / Codex binaries, with Playwright driving the browser
// sign-in and consent. A fixture server serves a Client ID Metadata Document
// on a fixed port; the server maps one https host to it (cimd-transport.ts,
// only under E2E_MOCK=true).
const dataDir = path.resolve(process.env.SUPERAGENT_DATA_DIR ?? path.join(__dirname, '.e2e-data/mcp-oauth'))
process.env.SUPERAGENT_DATA_DIR = dataDir
const port = process.env.E2E_PORT ?? process.env.PORT ?? '3015'
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`
process.env.E2E_BASE_URL = baseURL
const CIMD_FIXTURE_PORT = process.env.MCP_OAUTH_CIMD_PORT ?? '3016'
process.env.MCP_OAUTH_CIMD_PORT = CIMD_FIXTURE_PORT
const CIMD_FIXTURE_HOST = 'cimd.gamut-e2e.dev'
const env = {
  SUPERAGENT_DATA_DIR: dataDir,
  AUTH_MODE: 'true',
  E2E_MOCK: 'true',
  ANTHROPIC_API_KEY: 'sk-ant-e2e-mock',
  PORT: port,
  VITE_CACHE_DIR: path.join(dataDir, '.vite'),
  GAMUT_E2E_CIMD_HOSTS: JSON.stringify({ [CIMD_FIXTURE_HOST]: `http://127.0.0.1:${CIMD_FIXTURE_PORT}` }),
}
const inline = Object.entries(env).map(([name, value]) => `${name}='${value}'`).join(' ')
const command = `${inline} node e2e/setup-e2e-data.js && ${inline} npm run dev:web`

export default defineConfig({
  testDir: './e2e/mcp/oauth',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/mcp-oauth',
  // One server whose switch and users the specs change: one test at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  reporter: [['list'], ['html', { open: 'never', outputFolder: process.env.PLAYWRIGHT_HTML_REPORT ?? 'playwright-report/mcp-oauth' }]],
  use: { ...devices['Desktop Chrome'], baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'mcp-oauth' }],
  webServer: { command, url: `${baseURL}/api/auth-config`, reuseExistingServer: false, timeout: 180_000, stdout: 'pipe' },
})
