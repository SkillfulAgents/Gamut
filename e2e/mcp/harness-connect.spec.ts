/**
 * Real Claude Code and Codex binaries connect to the server with the setup
 * the Settings page shows (client-setup.ts), report it connected, and list
 * exactly its tools to their model. The model is a stub: no account, no
 * model call, no secret.
 *
 * Without the binaries the tests skip, unless MCP_HARNESS_REQUIRED=1 (CI),
 * where a missing binary fails.
 */
import { expect, test, type TestInfo } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { claudeCodeSetup, codexSetup, MCP_CLIENT_SERVER_NAME } from '../../src/shared/lib/mcp-server/client-setup'
import { mcpTarget } from './harness/app'
import { EXPECTED_TOOL_NAMES } from './harness/expected-tools'
import { startStubModel, STUB_REPLY, type StubModel } from './harness/stub-models'
import { claudeBin, claudeEnv, codexBin, codexEnv, codexStubConfig, jsonLines, run, scratchHome, versionOf } from './harness/agent-clis'

test.describe.configure({ mode: 'serial' })

const required = process.env.MCP_HARNESS_REQUIRED === '1'
let stub: StubModel

test.beforeAll(async () => {
  stub = await startStubModel()
})

test.afterAll(async () => {
  await stub?.close()
})

/** Keep a CLI's output with the test's results (and in the report). */
async function evidence(testInfo: TestInfo, name: string, body: string) {
  const file = testInfo.outputPath(name)
  fs.writeFileSync(file, body)
  await testInfo.attach(name, { path: file, contentType: 'text/plain' })
}

function requireBinary(bin: string): string {
  const version = versionOf(bin)
  if (!version) {
    if (required) throw new Error(`${bin} is not installed, and MCP_HARNESS_REQUIRED=1`)
    test.skip(true, `${bin} is not installed`)
  }
  return version!
}

test.describe('Claude Code', () => {
  test('the Settings page command adds the server, and `claude mcp get` reports it connected', async () => {
    const testInfo = test.info()
    const version = requireBinary(claudeBin())
    testInfo.annotations.push({ type: 'claude-code', description: version })
    const { url, token } = await mcpTarget()
    const dirs = scratchHome('claude')
    const env = claudeEnv(dirs, stub.origin)
    // Exactly what the page shows, run by a shell as a person would paste it.
    const setup = claudeCodeSetup(url, token).replace(/^claude /, `${JSON.stringify(claudeBin())} `)
    const added = await run('/bin/sh', ['-c', setup], { cwd: dirs.project, env })
    expect(added.code, added.stderr).toBe(0)
    const got = await run(claudeBin(), ['mcp', 'get', MCP_CLIENT_SERVER_NAME], { cwd: dirs.project, env })
    await evidence(testInfo, 'claude-mcp-get.txt', `${got.stdout}\n${got.stderr}`)
    expect(got.stdout).toMatch(/Status: ✔ Connected/)
    const listed = await run(claudeBin(), ['mcp', 'list'], { cwd: dirs.project, env })
    expect(listed.stdout).toMatch(new RegExp(`${MCP_CLIENT_SERVER_NAME}: ${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(HTTP\\) - ✔ Connected`))
  })

  test('a wrong token is reported as a 401, not connected', async () => {
    requireBinary(claudeBin())
    const { url } = await mcpTarget()
    const dirs = scratchHome('claude-bad')
    const env = claudeEnv(dirs, stub.origin)
    const added = await run('/bin/sh', ['-c', claudeCodeSetup(url, 'gamut_mcp_wrong').replace(/^claude /, `${JSON.stringify(claudeBin())} `)], { cwd: dirs.project, env })
    expect(added.code).toBe(0)
    const got = await run(claudeBin(), ['mcp', 'get', MCP_CLIENT_SERVER_NAME], { cwd: dirs.project, env })
    // `claude mcp get` exits 0 either way: the status line is the answer.
    expect(got.stdout).toMatch(/Failed to connect/)
    expect(got.stdout).toMatch(/HTTP 401/)
    expect(got.stdout).not.toMatch(/✔ Connected/)
  })

  test('a headless turn lists exactly the Gamut tools to the model and finishes', async () => {
    const testInfo = test.info()
    requireBinary(claudeBin())
    const { url, token } = await mcpTarget()
    const dirs = scratchHome('claude-turn')
    const env = claudeEnv(dirs, stub.origin)
    const added = await run('/bin/sh', ['-c', claudeCodeSetup(url, token).replace(/^claude /, `${JSON.stringify(claudeBin())} `)], { cwd: dirs.project, env })
    expect(added.code, added.stderr).toBe(0)
    const before = stub.requests.length
    const turn = await run(claudeBin(), ['-p', 'Say hello.', '--output-format', 'stream-json', '--verbose'], { cwd: dirs.project, env, timeoutMs: 180_000 })
    await evidence(testInfo, 'claude-stream.jsonl', turn.stdout)
    expect(turn.code, turn.stderr).toBe(0)
    const events = jsonLines(turn.stdout)
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')
    expect(init, 'an init event').toBeTruthy()
    expect(init.mcp_servers).toContainEqual(expect.objectContaining({ name: MCP_CLIENT_SERVER_NAME, status: 'connected' }))
    const gamutTools = (init.tools as string[]).filter((name) => name.startsWith(`mcp__${MCP_CLIENT_SERVER_NAME}__`)).sort()
    expect(gamutTools).toEqual(EXPECTED_TOOL_NAMES.map((name) => `mcp__${MCP_CLIENT_SERVER_NAME}__${name}`).sort())
    const result = events.find((event) => event.type === 'result')
    expect(result?.is_error).toBe(false)
    expect(result?.result).toBe(STUB_REPLY)
    expect(stub.requests.slice(before).some((request) => request.path === '/v1/messages')).toBe(true)
  })
})

test.describe('Codex', () => {
  test('the Settings page config.toml is read: `codex mcp list` shows the server with its header', async () => {
    requireBinary(codexBin())
    const { url, token } = await mcpTarget()
    const dirs = scratchHome('codex')
    fs.writeFileSync(path.join(dirs.config, 'config.toml'), `${codexStubConfig(stub.origin)}\n${codexSetup(url, token)}\n`)
    const listed = await run(codexBin(), ['mcp', 'list', '--json'], { cwd: dirs.project, env: codexEnv(dirs) })
    expect(listed.code, listed.stderr).toBe(0)
    const servers = JSON.parse(listed.stdout)
    expect(servers).toContainEqual(expect.objectContaining({
      name: MCP_CLIENT_SERVER_NAME,
      enabled: true,
      auth_status: 'bearer_token',
      transport: expect.objectContaining({ type: 'streamable_http', url, http_headers: { Authorization: `Bearer ${token}` } }),
    }))
  })

  test('a headless `codex exec` turn connects and offers the model exactly the Gamut tools', async () => {
    const testInfo = test.info()
    const version = requireBinary(codexBin())
    testInfo.annotations.push({ type: 'codex', description: version })
    const { url, token } = await mcpTarget()
    const dirs = scratchHome('codex-turn')
    fs.writeFileSync(path.join(dirs.config, 'config.toml'), `${codexStubConfig(stub.origin)}\n${codexSetup(url, token)}\n`)
    const before = stub.requests.length
    const turn = await run(codexBin(), ['exec', '--skip-git-repo-check', '--json', 'Say hello.'], { cwd: dirs.project, env: codexEnv(dirs), timeoutMs: 180_000 })
    await evidence(testInfo, 'codex-exec.jsonl', `${turn.stdout}\n--- stderr ---\n${turn.stderr}`)
    await evidence(testInfo, 'codex-model-request.json', JSON.stringify(stub.requests.slice(before), null, 2))
    expect(turn.code, turn.stderr).toBe(0)
    const events = jsonLines(turn.stdout)
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true)
    expect(events.some((event) => event.item?.type === 'agent_message' && event.item.text === STUB_REPLY)).toBe(true)
    const request = stub.requests.slice(before).find((candidate) => candidate.path === '/v1/responses')
    expect(request, 'Codex called the stub model').toBeTruthy()
    const namespace = (request!.body.tools as any[]).find((tool) => tool.type === 'namespace' && tool.name === `mcp__${MCP_CLIENT_SERVER_NAME}`)
    expect(namespace, 'the Gamut tools, offered as an MCP namespace').toBeTruthy()
    expect((namespace.tools as Array<{ name: string }>).map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES)
    expect(namespace.description).toMatch(/^Gamut is a workspace of AI agents/)
  })

  test('a wrong token: the turn still runs, without the Gamut tools', async () => {
    requireBinary(codexBin())
    const { url } = await mcpTarget()
    const dirs = scratchHome('codex-bad')
    fs.writeFileSync(path.join(dirs.config, 'config.toml'), `${codexStubConfig(stub.origin)}\n${codexSetup(url, 'gamut_mcp_wrong')}\n`)
    const before = stub.requests.length
    const turn = await run(codexBin(), ['exec', '--skip-git-repo-check', '--json', 'Say hello.'], { cwd: dirs.project, env: codexEnv(dirs), timeoutMs: 180_000 })
    expect(turn.code, turn.stderr).toBe(0)
    const request = stub.requests.slice(before).find((candidate) => candidate.path === '/v1/responses')
    expect((request!.body.tools as any[]).some((tool) => tool.name === `mcp__${MCP_CLIENT_SERVER_NAME}`)).toBe(false)
  })
})
