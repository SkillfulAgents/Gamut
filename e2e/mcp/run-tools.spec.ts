/**
 * The run tools end to end: a real server (E2E mock container), the official
 * MCP client SDKs, real HTTP for uploads and downloads, and the app's own
 * routes and UI to check what happened on the Gamut side.
 *
 * The mock container answers by message: a plain prompt gets MOCK_REPLY,
 * "work very slowly" works for 12s, "ask question" asks one AskUserQuestion,
 * "ask secret" asks for a secret, "deliver file" delivers output/report.md.
 */
import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { api, baseUrl, dataDir, mcpTarget } from './harness/app'
import { connect, resultJson, type ClientKind, type ConnectedClient } from './harness/clients'
import { findOrCreateAgent, MOCK_REPLY, seedWorkspace, waitFor, type ApiAgent, type SeededWorkspace } from './harness/seed'

test.describe.configure({ mode: 'serial' })

let seeded: SeededWorkspace
let runner: ApiAgent

const RUNNER_AGENT_NAME = 'MCP Runner'
/** 150 bytes: the size the mock's deliver_file result announces. */
const REPORT_MD = `# Report\n\n${'All systems nominal. '.repeat(7)}`.padEnd(150, '.').slice(0, 150)

interface SessionListing { id: string; name: string; isActive?: boolean }

function workspacePath(slug: string, relative: string): string {
  return path.join(dataDir(), 'agents', slug, 'workspace', relative)
}

async function client(kind: ClientKind): Promise<ConnectedClient> {
  const { url, token } = await mcpTarget()
  return connect(kind, url, token)
}

async function metadataOf(slug: string, sessionId: string): Promise<Record<string, any> | undefined> {
  const all = await api<Record<string, Record<string, any>>>(`/api/debug/agents/${slug}/session-metadata`)
  return all[sessionId]
}

async function mainList(slug: string): Promise<string[]> {
  return (await api<SessionListing[]>(`/api/agents/${slug}/sessions`)).map((session) => session.id)
}

async function untilIdle(slug: string, sessionId: string) {
  await waitFor(`session ${sessionId} to go idle`, async () => {
    const session = await api<{ isActive?: boolean }>(`/api/agents/${slug}/sessions/${sessionId}`)
    return session.isActive === false
  }, 60_000)
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  seeded = await seedWorkspace()
  runner = await findOrCreateAgent(RUNNER_AGENT_NAME)
})

test.describe('invoke_agent', () => {
  const kinds: ClientKind[] = ['v1', 'v2-legacy', 'v2-modern', 'v2-auto']
  for (const kind of kinds) {
    test(`${kind}: invoke answers completed with the reply, a follow-up continues the session, and the session is an MCP one`, async () => {
      const mcp = await client(kind)
      try {
        const first = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: `Hello from ${kind}` }))
        expect(first).toMatchObject({ status: 'completed', last_message: MOCK_REPLY, pending_request: null, delivered_files: [] })
        expect(first.session_id).toBeTruthy()
        const second = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'And a follow-up', session_id: first.session_id }))
        expect(second).toMatchObject({ status: 'completed', session_id: first.session_id, last_message: MOCK_REPLY })

        const messages = await api<Array<{ type: string; content?: unknown }>>(`/api/agents/${runner.slug}/sessions/${first.session_id}/messages`)
        const userTexts = messages.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.content))
        expect(userTexts.some((text) => text.includes(`Hello from ${kind}`))).toBe(true)
        expect(userTexts.some((text) => text.includes('And a follow-up'))).toBe(true)

        // Provenance: the person, and the client's name where its era carries it per request.
        const meta = await metadataOf(runner.slug, first.session_id)
        expect(meta?.mcpInvocation).toEqual({ userId: 'local', clientName: kind === 'v2-modern' || kind === 'v2-auto' ? `gamut-e2e-v2-${kind.slice(3)}` : null })
        expect(meta?.promotedToInteractive).toBeFalsy()
        // Hidden from the main list, listed by list_sessions for the person who started it.
        expect(await mainList(runner.slug)).not.toContain(first.session_id)
        const listed = resultJson(await mcp.callTool('list_sessions', { agent: runner.displaySlug, limit: 100 }))
        expect(listed.sessions.map((session: { session_id: string }) => session.session_id)).toContain(first.session_id)
      } finally {
        await mcp.close()
      }
    })
  }

  test('a viewer-less agent slug is not found, and bad input is a tool error', async () => {
    const mcp = await client('v2-modern')
    try {
      const missing = await mcp.callTool('invoke_agent', { agent: 'no-such-agent', prompt: 'hi' })
      expect(missing.isError).toBe(true)
      expect(missing.content[0].text).toMatch(/Agent not found/)
      const unknownSession = await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'hi', session_id: 'not-a-session' })
      expect(unknownSession.isError).toBe(true)
      expect(unknownSession.content[0].text).toMatch(/Session not found/)
    } finally {
      await mcp.close()
    }
  })
})

test.describe('waiting', () => {
  for (const kind of ['v1', 'v2-modern'] as const) {
    test(`${kind}: a long turn answers running with the note; wait_for_session then answers completed; progress arrives while waiting`, async () => {
      test.setTimeout(120_000)
      const mcp = await client(kind)
      try {
        const startedAt = Date.now()
        // The mock turn works for 12s; a 2s wait ends with it still running.
        const first = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Please work very slowly on this', wait_seconds: 2 }))
        const took = Date.now() - startedAt
        expect(first.status).toBe('running')
        expect(first.note).toMatch(/wait_for_session/)
        expect(first.note).toMatch(/Do NOT call invoke_agent again/)
        expect(took).toBeGreaterThanOrEqual(1_500)
        expect(took).toBeLessThan(10_000)

        // The rest of the turn (about 10s) is long enough for two 5s ticks
        // of the wait's own clock; at least one must arrive.
        const progress: Array<{ progress: number; total?: number; message?: string }> = []
        const waited = resultJson(await mcp.callTool('wait_for_session', { agent: first.agent, session_id: first.session_id, wait_seconds: 30 }, { onprogress: (p) => progress.push(p) }))
        expect(waited).toMatchObject({ status: 'completed', session_id: first.session_id })
        expect(waited.last_message).toBeTruthy()
        expect(progress.length).toBeGreaterThanOrEqual(1)
        expect(progress[0]).toMatchObject({ progress: 5, total: 30 })
        expect(progress[0].message).toMatch(/working/)
        // A settled session answers at once.
        const again = Date.now()
        expect(resultJson(await mcp.callTool('wait_for_session', { agent: first.agent, session_id: first.session_id }))).toMatchObject({ status: 'completed' })
        expect(Date.now() - again).toBeLessThan(5_000)
      } finally {
        await mcp.close()
      }
    })
  }

  test('wait_seconds 0 returns once delivered; a client that gives up does not stop the session', async () => {
    test.setTimeout(90_000)
    const mcp = await client('v2-modern')
    try {
      const quick = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Please work very slowly again', wait_seconds: 0 }))
      expect(quick.status).toBe('running')

      // Cancel a wait mid-way: the client aborts, the session runs on.
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 2_000)
      await expect(mcp.callTool('wait_for_session', { agent: quick.agent, session_id: quick.session_id, wait_seconds: 40 }, { signal: controller.signal })).rejects.toThrow()
      const live = await api<{ isActive?: boolean }>(`/api/agents/${runner.slug}/sessions/${quick.session_id}`)
      expect(live.isActive).toBe(true)
      await untilIdle(runner.slug, quick.session_id)
      const done = resultJson(await mcp.callTool('wait_for_session', { agent: quick.agent, session_id: quick.session_id }))
      expect(done.status).toBe('completed')
    } finally {
      await mcp.close()
    }
  })
})

test.describe('sessions waiting on a person', () => {
  test('a question: awaiting_input with the question; invoke with the same session_id answers it; the session is promoted', async () => {
    test.setTimeout(90_000)
    const mcp = await client('v2-modern')
    try {
      const asked = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Please ask question about the database' }))
      expect(asked.status).toBe('awaiting_input')
      expect(asked.pending_request).toMatchObject({ kind: 'question' })
      expect(asked.pending_request.text).toMatch(/Which database should we use\?/)
      expect(asked.pending_request.text).toMatch(/PostgreSQL/)
      expect(asked.note).toMatch(/invoke_agent with this agent and session_id/)
      // The agent's own text, never the AskUserQuestion tool-use placeholder.
      expect(asked.last_message ?? '').not.toContain('[tool_use')
      // Waiting on a person promotes it into the main list.
      await waitFor('the session to be promoted', async () => (await metadataOf(runner.slug, asked.session_id))?.promotedToInteractive === true)
      expect(await mainList(runner.slug)).toContain(asked.session_id)

      const answered = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, session_id: asked.session_id, prompt: 'PostgreSQL' }))
      expect(answered.session_id).toBe(asked.session_id)
      expect(answered.status).toBe('completed')
      const messages = await api<Array<{ type: string; content?: unknown }>>(`/api/agents/${runner.slug}/sessions/${asked.session_id}/messages`)
      expect(JSON.stringify(messages)).toContain('User provided input')
    } finally {
      await mcp.close()
    }
  })

  test('another kind of request: pending_request with a link that opens the session in Gamut; a prompt is not delivered', async ({ page }) => {
    test.setTimeout(90_000)
    const mcp = await client('v1')
    try {
      const asked = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Please ask secret for the key' }))
      expect(asked.status).toBe('awaiting_input')
      expect(asked.pending_request.kind).toBe('secret')
      expect(asked.pending_request.text).toMatch(/OPENAI_API_KEY/)
      expect(asked.pending_request.open_in_gamut_url).toBe(`${baseUrl()}/agents/${runner.slug}/sessions/${asked.session_id}`)
      expect(asked.note).toMatch(/open_in_gamut_url/)

      const before = (await api<unknown[]>(`/api/agents/${runner.slug}/sessions/${asked.session_id}/messages`)).length
      const notDelivered = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, session_id: asked.session_id, prompt: 'here you go' }))
      expect(notDelivered.status).toBe('awaiting_input')
      expect(notDelivered.note).toMatch(/NOT delivered/)
      expect((await api<unknown[]>(`/api/agents/${runner.slug}/sessions/${asked.session_id}/messages`)).length).toBe(before)

      await page.goto(asked.pending_request.open_in_gamut_url)
      await expect(page.getByTestId('session-breadcrumb')).toBeVisible({ timeout: 30_000 })
      await expect(page.getByTestId('inbound-x-agent-breadcrumb')).toBeVisible()
      await expect(page.getByText('OPENAI_API_KEY').first()).toBeVisible()
    } finally {
      await mcp.close()
    }
  })
})

test.describe('sessions MCP did not start', () => {
  test('a card with several questions is not answered through MCP: the link and every question', async () => {
    const mcp = await client('v2-modern')
    try {
      const asked = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Please ask multi questions' }))
      expect(asked.status).toBe('awaiting_input')
      expect(asked.pending_request.kind).toBe('question')
      for (const question of ['Which database should we use?', 'Which cloud provider do you prefer?', 'Preferred language?']) {
        expect(asked.pending_request.text).toContain(question)
      }
      expect(asked.note).toMatch(/several questions/)
      const again = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, session_id: asked.session_id, prompt: 'PostgreSQL' }))
      expect(again.status).toBe('awaiting_input')
      expect(again.note).toMatch(/NOT delivered/)
    } finally {
      await mcp.close()
    }
  })

  test('continuing a session a person started in the app leaves it theirs: no mcp origin, still in the main list', async () => {
    const created = await api<{ id: string }>(`/api/agents/${runner.slug}/sessions`, { method: 'POST', body: JSON.stringify({ message: 'Started in the app' }) })
    await untilIdle(runner.slug, created.id)
    const before = await metadataOf(runner.slug, created.id)
    expect(await mainList(runner.slug)).toContain(created.id)
    const mcp = await client('v2-modern')
    try {
      const result = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, session_id: created.id, prompt: 'A follow-up through MCP' }))
      expect(result).toMatchObject({ status: 'completed', session_id: created.id, last_message: MOCK_REPLY })
    } finally {
      await mcp.close()
    }
    const after = await metadataOf(runner.slug, created.id)
    expect(after?.mcpInvocation).toBeUndefined()
    expect(after?.invokedByAgentSlug).toBeUndefined()
    expect(after?.name).toBe(before?.name)
    expect(await mainList(runner.slug)).toContain(created.id)
  })
})

test.describe('files', () => {
  test('prepare_file_upload, PUT the bytes, invoke with the attachment: the file reaches the workspace and the prompt; the id works once', async () => {
    const mcp = await client('v2-modern')
    try {
      const bytes = Buffer.from(`hello from an MCP client ${Date.now()}\n`)
      const prepared = resultJson(await mcp.callTool('prepare_file_upload', { agent: runner.displaySlug, filename: 'notes.txt' }))
      expect(prepared.method).toBe('PUT')
      expect(prepared.upload_url.startsWith(`${baseUrl()}/api/signed-files/`)).toBe(true)
      expect(prepared.instructions).toContain('curl')
      const put = await fetch(prepared.upload_url, { method: 'PUT', body: bytes })
      expect(put.status).toBe(201)

      const invoked = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Read the attached file', attachments: [prepared.upload_id] }))
      expect(invoked.status).toBe('completed')
      const messages = await api<Array<{ type: string; content?: unknown }>>(`/api/agents/${runner.slug}/sessions/${invoked.session_id}/messages`)
      const prompt = messages.filter((entry) => entry.type === 'user').map((entry) => JSON.stringify(entry.content)).join('\n')
      const attached = /\/workspace\/(uploads\/notes-[A-Za-z0-9_-]+-\d+\.txt)/.exec(prompt)
      expect(attached, prompt).not.toBeNull()
      expect(fs.readFileSync(workspacePath(runner.slug, attached![1]))).toEqual(bytes)

      const reused = await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Again', attachments: [prepared.upload_id] })
      expect(reused.isError).toBe(true)
      expect(reused.content[0].text).toMatch(/not a finished upload/)
      // An upload URL is single use too.
      expect((await fetch(prepared.upload_url, { method: 'PUT', body: bytes })).status).toBe(410)
    } finally {
      await mcp.close()
    }
  })

  test('a delivered file: delivered_files in the result, get_file_download inline and as a URL whose GET returns the bytes; a workspace path too; traversal refused', async () => {
    const mcp = await client('v1')
    try {
      fs.mkdirSync(path.dirname(workspacePath(runner.slug, 'output/report.md')), { recursive: true })
      fs.writeFileSync(workspacePath(runner.slug, 'output/report.md'), REPORT_MD)
      const invoked = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'Please deliver file report' }))
      expect(invoked.status).toBe('completed')
      expect(invoked.delivered_files).toEqual([expect.objectContaining({ filename: 'report.md', size_bytes: 150 })])

      const delivered = resultJson(await mcp.callTool('get_file_download', { agent: runner.displaySlug, session_id: invoked.session_id, delivery_id: invoked.delivered_files[0].delivery_id }))
      expect(delivered).toMatchObject({ filename: 'report.md', size_bytes: 150, text: REPORT_MD })
      const got = await fetch(delivered.download_url)
      expect(got.status).toBe(200)
      expect(Buffer.from(await got.arrayBuffer()).toString()).toBe(REPORT_MD)

      const byPath = resultJson(await mcp.callTool('get_file_download', { agent: runner.displaySlug, path: '/workspace/output/report.md' }))
      expect(byPath).toMatchObject({ filename: 'report.md', size_bytes: 150, text: REPORT_MD })
      expect(await (await fetch(byPath.download_url)).text()).toBe(REPORT_MD)

      for (const bad of ['../../../etc/passwd', '/etc/passwd', 'output/../../secret']) {
        const refused = await mcp.callTool('get_file_download', { agent: runner.displaySlug, path: bad })
        expect(refused.isError, bad).toBe(true)
      }
    } finally {
      await mcp.close()
    }
  })
})

test.describe('ask_team_brain', () => {
  test('asks the Team Brain agent and answers with its reply', async () => {
    const mcp = await client('v2-auto')
    try {
      const answer = resultJson(await mcp.callTool('ask_team_brain', { question: 'Who are our customers?' }))
      expect(answer).toMatchObject({ status: 'completed', last_message: MOCK_REPLY, agent: seeded.brainAgent.displaySlug })
      const meta = await metadataOf(seeded.brainAgent.slug, answer.session_id)
      expect(meta?.mcpInvocation).toBeTruthy()
    } finally {
      await mcp.close()
    }
  })
})

test.describe('in Gamut', () => {
  test('MCP sessions show under "Called from Other Agents", not in the main list until promoted', async ({ page }) => {
    const mcp = await client('v2-modern')
    let sessionId: string
    try {
      sessionId = resultJson(await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: 'A hidden MCP session' })).session_id
    } finally {
      await mcp.close()
    }
    const inbound = await api<{ sessions: Array<{ id: string; mcp?: { clientName: string | null } }> }>(`/api/agents/${runner.slug}/inbound-x-agent`)
    expect(inbound.sessions.find((session) => session.id === sessionId)).toMatchObject({ mcp: { clientName: 'gamut-e2e-v2-modern' } })

    await page.goto(`${baseUrl()}/agents/${runner.slug}/called-from-agents`)
    const row = page.getByRole('button', { name: 'Open MCP session from gamut-e2e-v2-modern' }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('inbound-mcp-session-note').first()).toHaveText('Through MCP')

    await page.goto(`${baseUrl()}/agents/${runner.slug}/sessions/${sessionId}`)
    await expect(page.getByTestId('inbound-x-agent-breadcrumb')).toContainText('gamut-e2e-v2-modern')
    expect(await mainList(runner.slug)).not.toContain(sessionId)
  })

  test('one audit row per tool call: user, client, tool, target; never the prompt, the token or a URL', async () => {
    const { token } = await mcpTarget()
    const mcp = await client('v2-modern')
    const secretPrompt = `audit-canary-${Date.now()}`
    try {
      await mcp.callTool('invoke_agent', { agent: runner.displaySlug, prompt: secretPrompt })
      await mcp.callTool('list_drives', {})
    } finally {
      await mcp.close()
    }
    const page = await waitFor('the audit rows', async () => {
      const rows = await api<{ entries: Array<{ userId: string | null; object: string; objectId: string; action: string; details: string | null }> }>('/api/audit-log?object=mcp_tool&limit=100')
      return rows.entries.some((entry) => entry.details?.includes('"tool":"list_drives"')) ? rows : null
    })
    const invoke = page.entries.find((entry) => entry.details?.includes('"tool":"invoke_agent"') && entry.details.includes('gamut-e2e-v2-modern'))
    expect(invoke).toMatchObject({ userId: 'local', object: 'mcp_tool', action: 'called', objectId: runner.slug })
    const details = JSON.parse(invoke!.details!)
    expect(details).toMatchObject({ tool: 'invoke_agent', client: 'gamut-e2e-v2-modern', credential: 'installation-token', agent: runner.slug, outcome: 'ok' })
    expect(details.session_id).toBeTruthy()
    const all = JSON.stringify(page.entries)
    expect(all).not.toContain(secretPrompt)
    expect(all).not.toContain(token)
    expect(all).not.toContain('/api/signed-files/')
  })
})

// Every MCP suite in this run acts as user `local`, so all of them share one
// 120-calls-a-minute window. This test fills it, so it runs last; a suite that
// grows past ~120 tool calls within a minute would start seeing refusals.
test.describe('rate limit', () => {
  // Last: it uses up this minute's window for the local user.
  test('past 120 calls a minute, a tool error that says when to retry; the connection keeps working', async () => {
    test.setTimeout(120_000)
    const mcp = await client('v2-modern')
    try {
      let admitted = 0
      let refused: { content: Array<{ text?: string }>; isError?: boolean } | null = null
      // The window is a fixed minute from its first hit, and earlier tests may
      // have opened it: it can expire while this loop runs, which resets the
      // count. Two windows' worth of calls cannot all be admitted.
      for (let i = 0; i < 250 && !refused; i++) {
        const result = await mcp.callTool('get_guide', {})
        if (result.isError) refused = result
        else admitted++
      }
      expect(refused, 'no call was refused').not.toBeNull()
      // At most one window that was already open plus one full new one.
      expect(admitted).toBeLessThanOrEqual(240)
      expect(refused!.content[0].text).toMatch(/Rate limit: at most 120 Gamut tool calls a minute\. Nothing was done\. Wait \d+ seconds/)
      // Listing tools is not a tool call: the connection still answers.
      expect((await mcp.listTools()).tools.length).toBeGreaterThan(0)
    } finally {
      await mcp.close()
    }
  })
})
