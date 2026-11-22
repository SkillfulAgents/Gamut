/**
 * Real Claude Code and Codex connect to the auth-mode server through OAuth
 * with no model call: each signs in (discovery, registration, PKCE, the
 * browser consent, the code exchange), is reported connected, offers its
 * stub model exactly the Gamut tools, refreshes an expired token, and stops
 * working when the person disconnects it.
 *
 * The CLIs are what they are: this spec records which registration each
 * uses (both prefer a Client ID Metadata Document on their own domain, which
 * the server fetches from the internet, so this spec needs outbound https)
 * and checks Codex's DCR fallback too.
 *
 * Without the binaries the tests skip, unless MCP_HARNESS_REQUIRED=1 (CI).
 */
import { expect, test, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { claudeCodeOAuthSetup, codexOAuthSetup, MCP_CLIENT_SERVER_NAME } from '../../../src/shared/lib/mcp-server/client-setup'
import { EXPECTED_TOOL_NAMES } from '../harness/expected-tools'
import { startStubModel, STUB_REPLY, type StubModel } from '../harness/stub-models'
import { codexStubConfig, jsonLines, versionOf } from '../harness/agent-clis'
import { as, mcpUrl, people, setMcpEnabled, type Person } from './harness/oauth-app'
import {
  claudeCredentials,
  claudeRunner,
  codexBin,
  codexCredentials,
  codexOAuthEnv,
  codexOAuthHome,
  expireClaudeToken,
  expireCodexToken,
  plain,
  redact,
  runPlain,
  runSigningIn,
  type ClaudeRunner,
} from './harness/cli-oauth'

test.describe.configure({ mode: 'serial' })

const required = process.env.MCP_HARNESS_REQUIRED === '1'
let stub: StubModel

/**
 * The CLIs' Client ID Metadata Documents, which the server under test fetches
 * from the internet. The real fetch stays (it is what tells us an upstream
 * document stopped fitting our profile), but an unreachable upstream is not a
 * product failure: when the test process cannot reach a document for network
 * reasons (DNS, connect, timeout, 5xx) that CLI's spec is skipped, even under
 * MCP_HARNESS_REQUIRED=1, with a loud annotation. A 200 whose document the
 * server then refuses still fails the spec.
 */
const METADATA_DOCUMENTS = {
  codex: 'https://chatgpt.com/oauth/codex/client.json',
  claude: 'https://claude.ai/oauth/claude-code-client-metadata',
} as const
const unreachable: Partial<Record<keyof typeof METADATA_DOCUMENTS, string>> = {}

async function probeMetadataDocuments() {
  for (const [cli, url] of Object.entries(METADATA_DOCUMENTS) as Array<[keyof typeof METADATA_DOCUMENTS, string]>) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })
      if (response.status >= 500) unreachable[cli] = `${url} answered ${response.status}`
    } catch (error) {
      unreachable[cli] = `${url} could not be fetched: ${String((error as { cause?: unknown }).cause ?? error)}`
    }
  }
}

function skipWhenUpstreamUnreachable(cli: keyof typeof METADATA_DOCUMENTS) {
  const reason = unreachable[cli]
  if (!reason) return
  const message = `UPSTREAM UNREACHABLE, NOT A PRODUCT FAILURE: ${reason}. The ${cli} OAuth spec is skipped.`
  console.warn(`\n::warning::${message}\n`)
  test.info().annotations.push({ type: 'warning', description: message })
  test.skip(true, message)
}
let cast: Awaited<ReturnType<typeof people>>

test.beforeAll(async () => {
  await probeMetadataDocuments()
  stub = await startStubModel()
  cast = await people()
  await setMcpEnabled(cast.admin, true)
})

test.afterAll(async () => {
  await stub?.close()
})

async function evidence(testInfo: TestInfo, name: string, body: string) {
  const file = testInfo.outputPath(name)
  fs.writeFileSync(file, redact(body))
  await testInfo.attach(name, { path: file, contentType: 'text/plain' })
}

function revoke(person: Person, clientId: string) {
  return as(person, '/api/mcp-server/oauth/clients/revoke', { method: 'POST', body: JSON.stringify({ clientId }) })
}

/** What `codex mcp add gamut --url <url>` writes, without its immediate browser sign-in. */
function writeCodexServer(dirs: { config: string }) {
  fs.appendFileSync(path.join(dirs.config, 'config.toml'), `\n[mcp_servers.${MCP_CLIENT_SERVER_NAME}]\nurl = "${mcpUrl()}"\n`)
}

function stubPort(): number {
  return Number(new URL(stub.origin).port)
}

test.describe('Codex', () => {
  test.beforeEach(() => {
    // The forced-DCR test fetches no document.
    if (!test.info().title.includes('DCR')) skipWhenUpstreamUnreachable('codex')
    if (!versionOf(codexBin())) {
      if (required) throw new Error('codex is not installed, and MCP_HARNESS_REQUIRED=1')
      test.skip(true, 'codex is not installed')
    }
  })

  test('the Settings page commands sign in by its metadata document, offer exactly the tools, refresh, and stop when disconnected', async ({ browser }) => {
    const testInfo = test.info()
    testInfo.annotations.push({ type: 'codex', description: versionOf(codexBin()) ?? '' })
    const dirs = codexOAuthHome('codex-oauth')
    const env = codexOAuthEnv(dirs)
    // The page's two commands. `codex mcp add` signs in at once and opens the
    // machine's browser to do it (on macOS whatever BROWSER says), so the
    // spec writes the table it would write and signs in with the page's
    // second command, printing the URL instead of opening a browser.
    const [addLine, loginLine] = codexOAuthSetup(mcpUrl()).split('\n')
    expect(addLine).toBe(`codex mcp add ${MCP_CLIENT_SERVER_NAME} --url "${mcpUrl()}"`)
    expect(loginLine).toBe(`codex mcp login ${MCP_CLIENT_SERVER_NAME}`)
    writeCodexServer(dirs)
    const added = await runSigningIn(codexBin(), [...loginLine.split(' ').slice(1), '--no-browser'], { cwd: dirs.project, env, browser, person: cast.admin, paste: true })
    await evidence(testInfo, 'codex-mcp-login.txt', `${added.authorizeUrl?.href ?? 'no URL'}\n\n${plain(added.output)}`)
    expect(added.code, plain(added.output)).toBe(0)
    expect(plain(added.output)).toContain('Successfully logged in')
    // Registration: Codex's own Client ID Metadata Document.
    const clientId = added.authorizeUrl!.searchParams.get('client_id')!
    expect(clientId).toBe('https://chatgpt.com/oauth/codex/client.json')
    expect(added.authorizeUrl!.searchParams.get('code_challenge_method')).toBe('S256')
    expect(added.authorizeUrl!.searchParams.get('resource')).toBe(mcpUrl())

    const listed = await runPlain(codexBin(), ['mcp', 'list', '--json'], { cwd: dirs.project, env })
    expect(JSON.parse(listed.output.slice(listed.output.indexOf('[')))).toContainEqual(expect.objectContaining({ name: MCP_CLIENT_SERVER_NAME, auth_status: 'o_auth' }))
    const stored = Object.values(codexCredentials(dirs))[0] as Record<string, any>
    expect(stored.refresh_token).toMatch(/^gamut_rt_/)

    // The stub as its model, the MCP server as `codex mcp add` wrote it.
    const config = fs.readFileSync(path.join(dirs.config, 'config.toml'), 'utf8').replace('mcp_oauth_credentials_store = "file"\n', '')
    fs.writeFileSync(path.join(dirs.config, 'config.toml'), `mcp_oauth_credentials_store = "file"\n${codexStubConfig(stub.origin)}\n${config}`)
    const offered = async (label: string) => {
      const before = stub.requests.length
      const turn = await runPlain(codexBin(), ['exec', '--skip-git-repo-check', '--json', 'Say hello.'], { cwd: dirs.project, env })
      await evidence(testInfo, `codex-exec-${label}.jsonl`, turn.output)
      expect(turn.code, plain(turn.output)).toBe(0)
      expect(jsonLines(plain(turn.output).replace(/\r/g, '')).some((event) => event.item?.type === 'agent_message' && event.item.text === STUB_REPLY)).toBe(true)
      const request = stub.requests.slice(before).find((candidate) => candidate.path === '/v1/responses')
      const namespace = (request?.body.tools as any[] | undefined)?.find((tool) => tool.type === 'namespace' && tool.name === `mcp__${MCP_CLIENT_SERVER_NAME}`)
      return namespace ? (namespace.tools as Array<{ name: string }>).map((tool) => tool.name).sort() : null
    }
    expect(await offered('connected')).toEqual(EXPECTED_TOOL_NAMES)

    // An expired access token: Codex refreshes it (the refresh token rotates) and connects.
    expireCodexToken(dirs)
    expect(await offered('after-expiry')).toEqual(EXPECTED_TOOL_NAMES)
    const refreshed = Object.values(codexCredentials(dirs))[0] as Record<string, any>
    expect(refreshed.access_token).not.toBe(stored.access_token)
    expect(refreshed.refresh_token).toMatch(/^gamut_rt_/)
    expect(refreshed.refresh_token).not.toBe(stored.refresh_token)

    // Disconnected in Gamut: the turn still runs, without the Gamut tools.
    await revoke(cast.admin, clientId)
    expect(await offered('after-disconnect')).toBeNull()
  })

  test('with registration forced to DCR, Codex registers itself and connects', async ({ browser }) => {
    const dirs = codexOAuthHome('codex-oauth-dcr')
    const env = codexOAuthEnv(dirs)
    writeCodexServer(dirs)
    const added = await runSigningIn(codexBin(), ['mcp', 'login', MCP_CLIENT_SERVER_NAME, '--no-browser', '--oauth-client-registration', 'dcr'], { cwd: dirs.project, env, browser, person: cast.admin, paste: true })
    await evidence(test.info(), 'codex-mcp-login-dcr.txt', `${added.authorizeUrl?.href ?? 'no URL'}\n\n${plain(added.output)}`)
    expect(plain(added.output)).toContain('Successfully logged in')
    expect(added.authorizeUrl!.searchParams.get('client_id')).toMatch(/^[A-Za-z]{32}$/)
  })
})

test.describe('Claude Code', () => {
  let runner: ClaudeRunner

  test.beforeEach(() => {
    skipWhenUpstreamUnreachable('claude')
  })

  test.beforeAll(() => {
    const made = claudeRunner('claude-oauth', { server: Number(new URL(mcpUrl()).port), stub: stubPort() })
    if ('skip' in made) {
      if (required) throw new Error(made.skip)
      test.skip(true, made.skip)
      return
    }
    if (!made.version()) {
      if (required) throw new Error('claude is not installed, and MCP_HARNESS_REQUIRED=1')
      test.skip(true, 'claude is not installed')
    }
    runner = made
  })

  test('the Settings page command and `claude mcp login` sign in by its metadata document, then connect, list the tools, refresh, and stop when disconnected', async ({ browser }) => {
    const testInfo = test.info()
    testInfo.annotations.push({ type: 'claude-code', description: `${runner.version()} (${runner.mode})` })
    const run = (args: string[], extraEnv?: Record<string, string>) => {
      const call = runner.command(args, extraEnv)
      return runPlain(call.command, call.args, { cwd: call.cwd, env: call.env })
    }
    const setup = claudeCodeOAuthSetup(mcpUrl()).split(' ').slice(1).map((word) => word.replace(/^"|"$/g, ''))
    const added = await run(setup)
    expect(added.code, plain(added.output)).toBe(0)

    const login = runner.command(['mcp', 'login', MCP_CLIENT_SERVER_NAME, '--no-browser'])
    const signedIn = await runSigningIn(login.command, login.args, { cwd: login.cwd, env: login.env, browser, person: cast.member, paste: true })
    await evidence(testInfo, 'claude-mcp-login.txt', `${signedIn.authorizeUrl?.href ?? 'no URL'}\n\n${plain(signedIn.output)}`)
    expect(plain(signedIn.output)).toContain(`Authenticated with "${MCP_CLIENT_SERVER_NAME}"`)
    const clientId = signedIn.authorizeUrl!.searchParams.get('client_id')!
    expect(clientId).toBe('https://claude.ai/oauth/claude-code-client-metadata')
    expect(signedIn.authorizeUrl!.searchParams.get('code_challenge_method')).toBe('S256')
    expect(signedIn.authorizeUrl!.searchParams.get('resource')).toBe(mcpUrl())

    const status = async (label: string) => {
      const got = await run(['mcp', 'get', MCP_CLIENT_SERVER_NAME])
      await evidence(testInfo, `claude-mcp-get-${label}.txt`, plain(got.output))
      return plain(got.output)
    }
    expect(await status('connected')).toMatch(/Status: ✔ Connected/)
    const stored = Object.values(claudeCredentials(runner).mcpOAuth)[0] as Record<string, any>
    expect(stored.refreshToken).toMatch(/^gamut_rt_/)

    const origin = runner.mode === 'docker' ? `http://localhost:${stubPort()}` : stub.origin
    const before = stub.requests.length
    const turn = await run(['-p', 'Say hello.', '--output-format', 'stream-json', '--verbose'], { ANTHROPIC_BASE_URL: origin })
    await evidence(testInfo, 'claude-stream.jsonl', turn.output)
    const events = jsonLines(plain(turn.output).replace(/\r/g, '\n'))
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
    expect(init?.mcp_servers).toContainEqual(expect.objectContaining({ name: MCP_CLIENT_SERVER_NAME, status: 'connected' }))
    const gamutTools = (init.tools as string[]).filter((name) => name.startsWith(`mcp__${MCP_CLIENT_SERVER_NAME}__`)).sort()
    expect(gamutTools).toEqual(EXPECTED_TOOL_NAMES.map((name) => `mcp__${MCP_CLIENT_SERVER_NAME}__${name}`).sort())
    expect(events.find((event) => event.type === 'result')?.result).toBe(STUB_REPLY)
    expect(stub.requests.slice(before).some((request) => request.path === '/v1/messages')).toBe(true)

    // An expired access token: Claude Code refreshes it (the refresh token rotates) and connects.
    expireClaudeToken(runner)
    expect(await status('after-expiry')).toMatch(/Status: ✔ Connected/)
    const refreshed = Object.values(claudeCredentials(runner).mcpOAuth)[0] as Record<string, any>
    expect(refreshed.accessToken).not.toBe(stored.accessToken)
    expect(refreshed.refreshToken).not.toBe(stored.refreshToken)

    // Disconnected in Gamut: no longer connected.
    await revoke(cast.member, clientId)
    expect(await status('after-disconnect')).not.toMatch(/✔ Connected/)
  })
})
