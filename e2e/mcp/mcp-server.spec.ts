/**
 * The MCP server end to end: a real server process (E2E mock container), real
 * HTTP, the official MCP client SDKs of both generations, and data seeded
 * through the app's own routes.
 */
import { expect, test } from '@playwright/test'
import { mcpTarget, regenerateToken, setMcpEnabled, baseUrl } from './harness/app'
import { CLIENT_KINDS, connect, connectV1, connectV2, resultJson, type ConnectedClient } from './harness/clients'
import { EXPECTED_TOOLS, EXPECTED_TOOL_NAMES } from './harness/expected-tools'
import { startHeaderProxy } from './harness/header-proxy'
import { MOCK_REPLY, SESSION_MESSAGES, seedWorkspace, type SeededWorkspace } from './harness/seed'

test.describe.configure({ mode: 'serial' })

let seeded: SeededWorkspace

test.beforeAll(async () => {
  test.setTimeout(180_000)
  seeded = await seedWorkspace()
})

async function rawPost(url: string, headers: Record<string, string>) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } }),
  })
}

test.describe('connecting', () => {
  for (const kind of CLIENT_KINDS) {
    test(`${kind}: connects with the installation token and reads the server's instructions`, async () => {
      const { url, token } = await mcpTarget()
      const client = await connect(kind, url, token)
      try {
        expect(client.serverName()).toBe('gamut')
        expect(client.instructions()).toMatch(/^Gamut is a workspace of AI agents/)
        expect(client.instructions()!.length).toBeLessThan(4096)
      } finally {
        await client.close()
      }
    })
  }

  test('each era is what goes over the wire: modern sends server/discover and per-request versions, legacy initialize', async () => {
    const { token } = await mcpTarget()
    const proxy = await startHeaderProxy(baseUrl(), {})
    try {
      const modern = await connectV2(`${proxy.origin}/mcp`, token, 'modern')
      await modern.listTools()
      await modern.close()
      const modernSeen = proxy.seen.splice(0)
      expect(modernSeen.map((request) => request.mcpMethod)).toEqual(expect.arrayContaining(['server/discover', 'tools/list']))
      expect(modernSeen.filter((request) => request.method === 'POST').every((request) => request.protocolVersion === '2026-07-28')).toBe(true)
      expect(modernSeen.every((request) => request.status < 400)).toBe(true)

      const legacy = await connectV1(`${proxy.origin}/mcp`, token)
      await legacy.listTools()
      await legacy.close()
      const legacySeen = proxy.seen.splice(0)
      expect(legacySeen.some((request) => request.mcpMethod !== null)).toBe(false)
      expect(legacySeen.filter((request) => request.method === 'POST' && request.protocolVersion !== null).every((request) => request.protocolVersion!.startsWith('2025-'))).toBe(true)
      expect(legacySeen.filter((request) => request.method === 'POST').every((request) => request.status < 400)).toBe(true)
    } finally {
      await proxy.close()
    }
  })

  test('refuses a missing or wrong token: 401 with a plain Bearer challenge, and no client connects', async () => {
    const { url } = await mcpTarget()
    const variants: Array<Record<string, string>> = [{}, { Authorization: "Bearer gamut_mcp_not-the-token" }]
    for (const headers of variants) {
      const response = await rawPost(url, headers)
      expect(response.status).toBe(401)
      expect(response.headers.get('www-authenticate')).toBe('Bearer')
    }
    await expect(connectV1(url, null)).rejects.toThrow()
    await expect(connectV1(url, 'gamut_mcp_wrong')).rejects.toThrow()
    await expect(connectV2(url, 'gamut_mcp_wrong', 'modern')).rejects.toThrow()
    await expect(connectV2(url, 'gamut_mcp_wrong', 'legacy')).rejects.toThrow()
  })

  test('the token is not a credential for /api: an agent-facing route refuses it', async () => {
    const { token } = await mcpTarget()
    const response = await fetch(`${baseUrl()}/api/x-agent/list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
  })
})

test.describe('the tool list', () => {
  for (const kind of CLIENT_KINDS) {
    test(`${kind}: exactly the expected tools, titles and annotations`, async () => {
      const { url, token } = await mcpTarget()
      const client = await connect(kind, url, token)
      try {
        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES)
        for (const expected of EXPECTED_TOOLS) {
          const tool = tools.find((candidate) => candidate.name === expected.name)!
          expect(tool.title).toBe(expected.title)
          expect(tool.annotations).toEqual({ title: expected.title, ...expected.annotations })
          expect(tool.outputSchema).toMatchObject({ type: 'object' })
        }
      } finally {
        await client.close()
      }
    })
  }
})

test.describe('every tool, against seeded data', () => {
  let client: ConnectedClient

  test.beforeEach(async () => {
    const { url, token } = await mcpTarget()
    client = await connect('v2-modern', url, token)
  })

  test.afterEach(async () => {
    await client.close()
  })

  test('get_guide: the overview and a topic', async () => {
    const overview = resultJson(await client.callTool('get_guide'))
    expect(overview.topic).toBe('overview')
    expect(overview.content).toMatch(/Team Brain/)
    const safety = resultJson(await client.callTool('get_guide', { topic: 'safety' }))
    expect(safety.content).toMatch(/untrusted input/)
  })

  test('list_drives: the Team Brain drive, with its INDEX.md', async () => {
    const result = resultJson(await client.callTool('list_drives'))
    const brain = result.drives.find((drive: { id: string }) => drive.id === seeded.drive.id)
    expect(brain).toMatchObject({ team_brain: true, type: 'local', health: 'ok', index_md: seeded.files.index, index_md_truncated: false })
    expect(result.drives[0].id).toBe(seeded.drive.id)
  })

  test('list_drive_files: one level at a time', async () => {
    const root = resultJson(await client.callTool('list_drive_files', { drive: seeded.drive.id }))
    expect(root.entries.map((entry: { type: string; name: string }) => `${entry.type}:${entry.name}`)).toEqual(['directory:assets', 'directory:notes', 'file:INDEX.md'])
    const notes = resultJson(await client.callTool('list_drive_files', { drive: seeded.drive.id, path: 'notes' }))
    expect(notes.entries).toEqual([expect.objectContaining({ name: 'customers.md', path: 'notes/customers.md', type: 'file', size_bytes: Buffer.byteLength(seeded.files.notes) })])
    const escape = await client.callTool('list_drive_files', { drive: seeded.drive.id, path: '../..' })
    expect(escape.isError).toBe(true)
  })

  test('read_drive_file: a long text file in pages that add up to the file', async () => {
    const lines = seeded.files.notes.split('\n')
    const pages: string[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const page = resultJson(await client.callTool('read_drive_file', { drive: seeded.drive.id, path: 'notes/customers.md', offset }))
      expect(page.kind).toBe('text')
      expect(page.total_lines).toBe(lines.length)
      expect(JSON.stringify(page).length).toBeLessThanOrEqual(60_000)
      pages.push(page.content)
      offset = page.next_offset
    }
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.join('\n')).toBe(seeded.files.notes)
  })

  test('read_drive_file: a binary file as a signed URL that downloads its bytes', async () => {
    const result = resultJson(await client.callTool('read_drive_file', { drive: seeded.drive.id, path: 'assets/logo.png' }))
    expect(result).toMatchObject({ kind: 'download', mime_type: 'image/png', size_bytes: seeded.files.binary.length })
    expect(new Date(result.expires_at).getTime()).toBeGreaterThan(Date.now())
    const download = await fetch(result.download_url)
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(seeded.files.binary)
    // The URL is the credential: tampered, it is refused.
    expect((await fetch(`${result.download_url}x`)).status).toBe(401)
  })

  test('list_agents: both agents, the Team Brain flagged', async () => {
    const result = resultJson(await client.callTool('list_agents'))
    const byName = Object.fromEntries(result.agents.map((agent: { name: string }) => [agent.name, agent]))
    expect(byName[seeded.brainAgent.name]).toMatchObject({ slug: seeded.brainAgent.displaySlug, team_brain: true })
    expect(byName[seeded.researchAgent.name]).toMatchObject({ slug: seeded.researchAgent.displaySlug, team_brain: false })
    expect(typeof byName[seeded.researchAgent.name].status).toBe('string')
  })

  test('list_sessions: newest first, as the app lists them', async () => {
    const result = resultJson(await client.callTool('list_sessions', { agent: seeded.researchAgent.displaySlug }))
    const seededIds = seeded.sessions.map((session) => session.id)
    const listed = result.sessions.map((session: { session_id: string }) => session.session_id).filter((id: string) => seededIds.includes(id))
    expect(listed).toEqual([...seededIds].reverse())
    const app = await (await fetch(`${baseUrl()}/api/agents/${seeded.researchAgent.slug}/sessions`)).json() as Array<{ id: string }>
    expect(result.sessions.map((session: { session_id: string }) => session.session_id)).toEqual(app.map((session) => session.id))
  })

  test('read_session: the transcript with the seeded message and the reply', async () => {
    for (const [index, session] of seeded.sessions.entries()) {
      const result = resultJson(await client.callTool('read_session', { agent: seeded.researchAgent.displaySlug, session_id: session.id }))
      expect(result.status).toBe('idle')
      expect(result.messages.some((message: { role: string; content: string }) => message.role === 'user' && message.content.includes(SESSION_MESSAGES[index]))).toBe(true)
      expect(result.messages.some((message: { role: string; content: string }) => message.role === 'assistant' && message.content.includes(MOCK_REPLY))).toBe(true)
    }
    const missing = await client.callTool('read_session', { agent: seeded.researchAgent.displaySlug, session_id: 'no-such-session' })
    expect(missing.isError).toBe(true)
  })
})

test.describe('changing access mid-run', () => {
  test('regenerate: a connected client is refused on its next call; the new token connects', async () => {
    const before = await mcpTarget()
    const client = await connectV1(before.url, before.token)
    try {
      expect(resultJson(await client.callTool('get_guide')).topic).toBe('overview')
      const after = await regenerateToken()
      expect(after.token).not.toBe(before.token)
      await expect(client.callTool('get_guide')).rejects.toThrow()
      const fresh = await connectV2(after.endpointUrl, after.token!, 'modern')
      expect(resultJson(await fresh.callTool('get_guide')).topic).toBe('overview')
      await fresh.close()
    } finally {
      await client.close().catch(() => {})
    }
  })

  test('switched off: 404 to every request, token or not; back on, it serves again', async () => {
    const { url, token } = await mcpTarget()
    try {
      const off = await setMcpEnabled(false)
      expect(off.enabled).toBe(false)
      expect((await rawPost(url, { Authorization: `Bearer ${token}` })).status).toBe(404)
      expect((await rawPost(url, {})).status).toBe(404)
      await expect(connectV2(url, token, 'modern')).rejects.toThrow()
    } finally {
      await setMcpEnabled(true)
    }
    const client = await connectV1(url, token)
    expect((await client.listTools()).tools).toHaveLength(EXPECTED_TOOLS.length)
    await client.close()
  })
})
