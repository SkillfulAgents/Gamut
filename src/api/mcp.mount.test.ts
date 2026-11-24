/**
 * `/mcp` as the real app mounts it (src/api/index.ts), without auth mode:
 * the installation token, the admin switch, both protocol eras over raw
 * JSON-RPC, and every read tool against a test database, a real local drive
 * and fake agent actors.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { agents } from '@shared/lib/db/schema'
import { runtimeCapabilities } from '@shared/lib/facts/capabilities'
import { declareServerCapabilities } from '@shared/lib/facts/server-facts'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('@shared/lib/auth/config', async (original) => ({
  ...(await original<typeof import('@shared/lib/auth/config')>()),
  getAppBaseUrl: async () => 'http://localhost:47891',
}))

const actors = vi.hoisted(() => {
  type Session = { id: string; name: string; createdAt: Date; lastActivityAt: Date; hidden?: boolean }
  const sessions: Record<string, Session[]> = {}
  const transcripts: Record<string, Array<{ role: string; content: string; toolName?: string }>> = {}
  return { sessions, transcripts }
})
vi.mock('@shared/lib/agent-actor/registry', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      live: async () => ({
        container: { status: slug === 'alpha' ? 'running' : 'stopped', port: null, healthWarnings: [], stale: false, idleSince: null },
        activeSessionIds: [],
      }),
      listing: async () => (slug === 'alpha'
        ? {
            live: { activeSessionIds: ['s-new'], awaitingSessionIds: [], pendingReviews: [] },
            sessions: { sessionIds: ['s-new', 's-hidden'], sessionCount: 2, lastActivityAt: new Date(5_000), metadata: { 's-hidden': { isScheduledExecution: true } } },
            artifacts: { dashboards: [{ slug: 'pipeline', name: 'Pipeline' }], widgets: [] },
          }
        : {
            live: { activeSessionIds: [], awaitingSessionIds: [], pendingReviews: [] },
            sessions: { sessionIds: [], sessionCount: 0, lastActivityAt: null, metadata: {} },
            artifacts: { dashboards: [], widgets: [] },
          }),
      sessions: {
        list: async (options?: { excludeAutomated?: boolean }) => (actors.sessions[slug] ?? [])
          .filter((session) => !(options?.excludeAutomated && session.hidden))
          .map(({ hidden: _hidden, ...session }) => ({ ...session, agentSlug: slug })),
        readMetadata: async () => Object.fromEntries((actors.sessions[slug] ?? [])
          .filter((session) => session.hidden)
          .map((session) => [session.id, { isScheduledExecution: true }])),
        isKnown: async (id: string) => (actors.sessions[slug] ?? []).some((session) => session.id === id),
        live: async () => ({ isActive: false, isAwaitingInput: false }),
      },
      messages: {
        transcriptView: async (id: string) => ({
          messages: actors.transcripts[id] ?? [],
          total: (actors.transcripts[id] ?? []).length,
          deliveredFiles: [],
        }),
      },
    }),
  },
}))

import app from './index'
import { mutateSettings } from '@shared/lib/config/settings'
import { createVolumeDefinition } from '@shared/lib/services/volume-service'
import { getOrCreateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_LEAD } from '@shared/lib/mcp-server/guide'

const MODERN = '2026-07-28'
let root: string
let driveId: string

function rpc(method: string, params: Record<string, unknown> = {}, id: number | null = 1) {
  return { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }
}

function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'raw-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  })
}

/** The JSON-RPC message of a response, whether sent as JSON or as one SSE event. */
async function messageOf(response: Response): Promise<any> {
  const text = await response.text()
  if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean)
    return JSON.parse(data[data.length - 1])
  }
  return JSON.parse(text)
}

async function bearer(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await getOrCreateMcpInstallationToken()}` }
}

/**
 * One modern (2026-07-28) request: the version travels in `_meta` and in the
 * SEP-2243 headers (`MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name` for a
 * method that names its target).
 */
async function modern(method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = { ...(await bearer()), 'MCP-Protocol-Version': MODERN, 'Mcp-Method': method }
  if (typeof params.name === 'string') headers['Mcp-Name'] = params.name
  const response = await post(rpc(method, { ...params, _meta: modernMeta() }), headers)
  expect(response.status).toBe(200)
  return messageOf(response)
}

/** One 2025-era stateless request, with the version an initialize negotiated. */
async function legacy(method: string, params: Record<string, unknown> = {}) {
  const response = await post(rpc(method, params), { ...(await bearer()), 'MCP-Protocol-Version': '2025-11-25' })
  expect(response.status).toBe(200)
  return messageOf(response)
}

async function callTool(name: string, args: Record<string, unknown>) {
  const message = await legacy('tools/call', { name, arguments: args })
  expect(message.error).toBeUndefined()
  return message.result as { content: Array<{ type: string; text: string }>; structuredContent?: any; isError?: boolean }
}

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-mount-')))
  fs.mkdirSync(path.join(root, 'brain', 'notes'), { recursive: true })
  fs.writeFileSync(path.join(root, 'brain', 'INDEX.md'), '# Team Brain\nStart with notes/customers.md\n')
  fs.writeFileSync(path.join(root, 'brain', 'notes', 'customers.md'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'))
  fs.writeFileSync(path.join(root, 'brain', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))
  fs.writeFileSync(path.join(root, 'brain', 'secret-outside.txt'), 'inside the drive')
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside the drive')
})

beforeEach(async () => {
  declareServerCapabilities(runtimeCapabilities({ os: 'darwin', distribution: 'direct' }))
  handle = await createTestDatabase()
  await handle.db.insert(agents).values([
    { slug: 'alpha', name: 'Alpha', description: 'Does alpha things', createdAt: new Date(1_000) },
    { slug: 'brain', name: 'Brain', createdAt: new Date(2_000) },
  ]).run()
  driveId = (await createVolumeDefinition({ type: 'local', config: { path: path.join(root, 'brain') }, name: 'Brain drive' }, { userId: null, admin: true })).id
  await mutateSettings((s) => { s.teamBrain = { agentSlug: 'brain', volumeId: driveId } })
  actors.sessions.alpha = [
    { id: 's-new', name: 'Newest', createdAt: new Date(3_000), lastActivityAt: new Date(5_000) },
    { id: 's-hidden', name: 'Scheduled run', createdAt: new Date(2_500), lastActivityAt: new Date(4_000), hidden: true },
    { id: 's-old', name: 'Oldest', createdAt: new Date(1_000), lastActivityAt: new Date(2_000) },
  ]
  actors.transcripts['s-new'] = Array.from({ length: 120 }, (_, i) => (
    i % 3 === 2 ? { role: 'assistant', content: `[tool_use: Read]`, toolName: 'Read' } : { role: i % 3 === 0 ? 'user' : 'assistant', content: `message ${i}` }
  ))
})

afterEach(async () => {
  declareServerCapabilities(null)
  await backgroundSettled()
  await handle.close()
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the installation token', () => {
  it('refuses a request without a token with a plain Bearer challenge', async () => {
    const response = await post(rpc('tools/list'))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect(await response.text()).not.toContain('resource_metadata')
  })

  it('refuses a wrong token, and one that is not a Bearer', async () => {
    const token = await getOrCreateMcpInstallationToken()
    for (const authorization of ['Bearer gamut_mcp_wrong', `Basic ${token}`, `Bearer ${token}x`, 'Bearer']) {
      const response = await post(rpc('tools/list'), { Authorization: authorization })
      expect(response.status, authorization).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
    }
  })

  it('is one token per installation: 32 random bytes, stable across reads', async () => {
    const token = await getOrCreateMcpInstallationToken()
    expect(token).toMatch(/^gamut_mcp_[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token.slice('gamut_mcp_'.length), 'base64url')).toHaveLength(32)
    expect(await getOrCreateMcpInstallationToken()).toBe(token)
  })

  it('is not a credential on /api/*: an agent-facing route still refuses it', async () => {
    const response = await app.request('/api/x-agent/list', { method: 'POST', headers: { ...(await bearer()), 'Content-Type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(401)
  })

  it('regenerate replaces it: the old token is refused at once, the new one works', async () => {
    const before = await getOrCreateMcpInstallationToken()
    const regenerated = await app.request('/api/mcp-server/token/regenerate', { method: 'POST' })
    expect(regenerated.status).toBe(200)
    const { token: after } = await regenerated.json() as { token: string }
    expect(after).not.toBe(before)
    expect((await post(rpc('tools/list'), { Authorization: `Bearer ${before}` })).status).toBe(401)
    expect((await post(rpc('tools/list'), { Authorization: `Bearer ${after}`, 'MCP-Protocol-Version': '2025-11-25' })).status).toBe(200)
  })
})

describe('the admin switch', () => {
  it('is on by default without auth mode, and the settings route says where the endpoint is', async () => {
    const status = await (await app.request('http://localhost:47891/api/mcp-server')).json()
    expect(status).toMatchObject({ available: true, enabled: true, endpointUrl: 'http://localhost:47891/mcp', token: await getOrCreateMcpInstallationToken() })
  })

  it('answers 404 while off, even to the right token, and serves again once on', async () => {
    const off = await app.request('/api/mcp-server/enabled', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    expect((await off.json()).enabled).toBe(false)
    expect((await post(rpc('tools/list'), await bearer())).status).toBe(404)
    expect((await post(rpc('tools/list'))).status).toBe(404)
    await app.request('/api/mcp-server/enabled', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
    expect((await post(rpc('tools/list'), { ...(await bearer()), 'MCP-Protocol-Version': '2025-11-25' })).status).toBe(200)
  })
})

describe('both protocol eras, raw JSON-RPC', () => {
  it('answers a 2025-era initialize, then tools/list and tools/call as separate stateless requests', async () => {
    const init = await post(rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw-2025', version: '1.0.0' },
    }), await bearer())
    expect(init.status).toBe(200)
    expect(init.headers.get('mcp-session-id')).toBeNull()
    const initialized = await messageOf(init)
    expect(initialized.result.protocolVersion).toBe('2025-11-25')
    expect(initialized.result.serverInfo.name).toBe('gamut')
    expect(initialized.result.instructions).toBe(SERVER_INSTRUCTIONS)
    expect(initialized.result.capabilities.tools).toBeDefined()

    const notified = await post(rpc('notifications/initialized', {}, null), { ...(await bearer()), 'MCP-Protocol-Version': '2025-11-25' })
    expect(notified.status).toBe(202)

    const listed = await legacy('tools/list')
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      ['ask_team_brain', 'get_file_download', 'get_guide', 'invoke_agent', 'list_agents', 'list_drive_files', 'list_drives', 'list_sessions', 'prepare_file_upload', 'read_drive_file', 'read_session', 'wait_for_session'],
    )
    const called = await callTool('get_guide', {})
    expect(called.structuredContent.topic).toBe('overview')
  })

  it('answers a 2026-07-28 server/discover, tools/list and tools/call, each standing alone', async () => {
    const discovered = await modern('server/discover')
    expect(discovered.error).toBeUndefined()
    expect(discovered.result.supportedVersions).toContain(MODERN)
    expect(discovered.result.serverInfo?.name ?? discovered.result._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('gamut')
    expect(discovered.result.instructions).toBe(SERVER_INSTRUCTIONS)

    const listed = await modern('tools/list')
    expect(listed.result.tools).toHaveLength(12)
    const called = await modern('tools/call', { name: 'list_agents', arguments: {} })
    expect(called.result.isError).toBeFalsy()
    expect(called.result.structuredContent.agents.map((agent: { name: string }) => agent.name).sort()).toEqual(['Alpha', 'Brain'])
  })

  it('answers GET (a 2025 SSE stream request) with 405: nothing is kept between requests', async () => {
    const response = await app.request('/mcp', { method: 'GET', headers: { ...(await bearer()), Accept: 'text/event-stream' } })
    expect(response.status).toBe(405)
  })
})

describe('the tools', () => {
  it('every tool has a title, honest hints, a name within 64 characters and an output schema', async () => {
    const { result } = await legacy('tools/list')
    // The tools that make an agent act (or stage a file for it) are not read-only; none deletes anything.
    const acting = new Set(['invoke_agent', 'ask_team_brain', 'prepare_file_upload'])
    for (const tool of result.tools) {
      expect(tool.name.length).toBeLessThanOrEqual(64)
      expect(tool.title).toBeTruthy()
      expect(tool.annotations).toMatchObject({ readOnlyHint: !acting.has(tool.name), destructiveHint: false, title: tool.title })
      if (tool.name === 'invoke_agent' || tool.name === 'ask_team_brain') expect(tool.annotations).toMatchObject({ openWorldHint: true, idempotentHint: false })
      expect(tool.outputSchema?.type).toBe('object')
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('instructions stay under 4,096 characters, the first 512 self-contained', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(4096)
    expect(SERVER_INSTRUCTIONS_LEAD.length).toBeLessThanOrEqual(512)
    expect(SERVER_INSTRUCTIONS.startsWith(SERVER_INSTRUCTIONS_LEAD)).toBe(true)
    expect(SERVER_INSTRUCTIONS_LEAD).toMatch(/Gamut/)
    expect(SERVER_INSTRUCTIONS_LEAD).toMatch(/Team Brain/)
    expect(SERVER_INSTRUCTIONS_LEAD).toMatch(/get_guide/)
  })

  it('get_guide covers every topic and says transcripts and drives are untrusted', async () => {
    const overview = (await callTool('get_guide', {})).structuredContent
    for (const topic of overview.topics) {
      const result = await callTool('get_guide', { topic })
      expect(result.structuredContent.content.length).toBeGreaterThan(50)
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    }
    expect((await callTool('get_guide', { topic: 'safety' })).structuredContent.content).toMatch(/untrusted/)
    expect((await callTool('get_guide', { topic: 'nope' })).isError).toBe(true)
  })

  it('list_drives marks the Team Brain drive and carries its INDEX.md', async () => {
    const { structuredContent } = await callTool('list_drives', {})
    expect(structuredContent.drives).toEqual([expect.objectContaining({
      id: driveId, name: 'Brain drive', type: 'local', team_brain: true, health: 'ok',
      index_md: '# Team Brain\nStart with notes/customers.md\n', index_md_truncated: false,
    })])
    expect(structuredContent.next_offset).toBeNull()
  })

  it('list_drive_files lists one level, folders first, by id or by name', async () => {
    const root = (await callTool('list_drive_files', { drive: driveId, path: '' })).structuredContent
    expect(root.entries.map((entry: { name: string; type: string }) => `${entry.type}:${entry.name}`)).toEqual([
      'directory:notes', 'file:INDEX.md', 'file:logo.png', 'file:secret-outside.txt',
    ])
    const notes = (await callTool('list_drive_files', { drive: 'brain drive', path: 'notes/' })).structuredContent
    expect(notes.entries).toEqual([expect.objectContaining({ name: 'customers.md', path: 'notes/customers.md', type: 'file' })])
    const paged = (await callTool('list_drive_files', { drive: driveId, limit: 2 })).structuredContent
    expect(paged.entries).toHaveLength(2)
    expect(paged.next_offset).toBe(2)
    expect(paged.total).toBe(4)
  })

  it('refuses paths that leave the drive', async () => {
    for (const bad of ['../outside.txt', 'notes/../../outside.txt', '/etc/passwd', 'notes\\..\\x', './INDEX.md', 'a\0b']) {
      const listed = await callTool('list_drive_files', { drive: driveId, path: bad })
      expect(listed.isError, bad).toBe(true)
      expect(listed.content[0].text).toMatch(/Invalid path/)
      const read = await callTool('read_drive_file', { drive: driveId, path: bad })
      expect(read.isError, bad).toBe(true)
    }
  })

  it('read_drive_file pages a text file by lines and hands a binary file a signed URL', async () => {
    const first = (await callTool('read_drive_file', { drive: driveId, path: 'notes/customers.md', limit: 10 })).structuredContent
    expect(first).toMatchObject({ kind: 'text', offset: 0, lines_returned: 10, total_lines: 30, next_offset: 10 })
    expect(first.content.split('\n')[0]).toBe('line 0')
    const last = (await callTool('read_drive_file', { drive: driveId, path: 'notes/customers.md', offset: 25 })).structuredContent
    expect(last).toMatchObject({ lines_returned: 5, next_offset: null })
    expect((await callTool('read_drive_file', { drive: driveId, path: 'notes/customers.md', offset: 99 })).isError).toBe(true)

    const binary = (await callTool('read_drive_file', { drive: driveId, path: 'logo.png' })).structuredContent
    expect(binary).toMatchObject({ kind: 'download', mime_type: 'image/png', size_bytes: 7 })
    // At the origin the client reached /mcp at, not the configured bound address (http://localhost:47891 here).
    expect(new URL(binary.download_url).origin).toBe('http://localhost')
    const download = await app.request(new URL(binary.download_url).pathname)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(fs.readFileSync(path.join(root, 'brain', 'logo.png')))

    expect((await callTool('read_drive_file', { drive: driveId, path: 'notes' })).content[0].text).toMatch(/folder/)
    expect((await callTool('read_drive_file', { drive: driveId, path: 'missing.md' })).content[0].text).toMatch(/No file or folder/)
    expect((await callTool('read_drive_file', { drive: 'no-such-drive', path: 'x.md' })).content[0].text).toMatch(/list_drives/)
  })

  it('list_agents gives slug, name, description, status, the Team Brain flag and the resume', async () => {
    const { structuredContent } = await callTool('list_agents', {})
    const byName = Object.fromEntries(structuredContent.agents.map((agent: { name: string }) => [agent.name, agent]))
    expect(byName.Alpha).toMatchObject({
      description: 'Does alpha things', status: 'running', team_brain: false,
      created_at: new Date(1_000).toISOString(), session_running: true, needs_input: false,
      last_activity_at: new Date(5_000).toISOString(), session_count: 2, automated_session_count: 1, dashboards: ['Pipeline'],
    })
    expect(byName.Brain).toMatchObject({ description: null, status: 'stopped', team_brain: true })
    expect(byName.Alpha.slug).toMatch(/alpha/)
  })

  it('list_sessions lists what the app lists, newest first, paged', async () => {
    const agent = (await callTool('list_agents', {})).structuredContent.agents.find((a: { name: string }) => a.name === 'Alpha').slug
    const all = (await callTool('list_sessions', { agent })).structuredContent
    expect(all.sessions.map((session: { session_id: string }) => session.session_id)).toEqual(['s-new', 's-old'])
    expect(all.total).toBe(2)
    const page = (await callTool('list_sessions', { agent, limit: 1 })).structuredContent
    expect(page).toMatchObject({ total: 2, next_offset: 1 })
    expect((await callTool('list_sessions', { agent: 'nobody' })).content[0].text).toMatch(/list_agents/)
  })

  it('read_session pages the transcript oldest first with role, content and toolName', async () => {
    const first = (await callTool('read_session', { agent: 'alpha', session_id: 's-new' })).structuredContent
    expect(first).toMatchObject({ status: 'idle', total_messages: 120, offset: 0, next_offset: 50 })
    expect(first.messages[0]).toEqual({ index: 0, role: 'user', content: 'message 0' })
    expect(first.messages[2]).toEqual({ index: 2, role: 'assistant', content: '[tool_use: Read]', toolName: 'Read' })
    const last = (await callTool('read_session', { agent: 'alpha', session_id: 's-new', offset: 100, limit: 200 })).structuredContent
    expect(last.messages).toHaveLength(20)
    expect(last.next_offset).toBeNull()
    expect((await callTool('read_session', { agent: 'alpha', session_id: 's-new', limit: 201 })).isError).toBe(true)
    expect((await callTool('read_session', { agent: 'alpha', session_id: 'nope' })).content[0].text).toMatch(/list_sessions/)
  })

  it('keeps a page of long messages under the result budget', async () => {
    actors.transcripts['s-old'] = Array.from({ length: 40 }, () => ({ role: 'assistant', content: 'x'.repeat(20_000) }))
    const result = await callTool('read_session', { agent: 'alpha', session_id: 's-old' })
    expect(result.content[0].text.length).toBeLessThanOrEqual(60_000)
    expect(result.structuredContent.messages.length).toBeGreaterThan(0)
    expect(result.structuredContent.messages[0].content).toMatch(/truncated/)
    expect(result.structuredContent.next_offset).toBe(result.structuredContent.messages.length)
  })
})
