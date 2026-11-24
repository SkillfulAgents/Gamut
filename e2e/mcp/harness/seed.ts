/**
 * What the MCP suites read: seeded through the app's own routes, the way a
 * person would make it. A Team Brain (its agent, and a public local drive with
 * an INDEX.md, notes and a binary file), and a second agent with sessions whose
 * transcripts the mock container writes. Idempotent: a second call in the same
 * server run finds what the first made.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { api, dataDir } from './app'

export interface SeededWorkspace {
  brainAgent: { slug: string; displaySlug: string; name: string }
  researchAgent: { slug: string; displaySlug: string; name: string }
  drive: { id: string; name: string; folder: string }
  sessions: Array<{ id: string; message: string }>
  files: { index: string; notes: string; binary: Buffer }
}

export const BRAIN_AGENT_NAME = 'Team Brain'
export const RESEARCH_AGENT_NAME = 'MCP Research'
export const SESSION_MESSAGES = ['Summarize the Q3 customer interviews', 'Draft the onboarding checklist']
/** What the mock container answers every message with (mock-container-client.ts). */
export const MOCK_REPLY = 'This is a mock response from the E2E test container.'

export const INDEX_MD = '# Team Brain\n\nHow this drive is organized:\n- notes/customers.md: who our customers are\n- assets/logo.png: the logo\n'
export const NOTES_MD = Array.from({ length: 1_500 }, (_, i) => `Customer note ${i}: Acme Corp renewed in week ${i % 52}.`).join('\n')
/** A PNG header and a few bytes: not text, so it is handed out as a download URL. */
export const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xde, 0xad, 0xbe, 0xef])

export interface ApiAgent { slug: string; displaySlug: string; name: string }

export async function findOrCreateAgent(name: string): Promise<ApiAgent> {
  const existing = (await api<ApiAgent[]>('/api/agents')).find((agent) => agent.name === name)
  return existing ?? api<ApiAgent>('/api/agents', { method: 'POST', body: JSON.stringify({ name }) })
}

export async function waitFor<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function writeDriveFiles(folder: string) {
  fs.mkdirSync(path.join(folder, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(folder, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(folder, 'INDEX.md'), INDEX_MD)
  fs.writeFileSync(path.join(folder, 'notes', 'customers.md'), NOTES_MD)
  fs.writeFileSync(path.join(folder, 'assets', 'logo.png'), BINARY)
}

async function setUpTeamBrain(agent: ApiAgent, folder: string): Promise<{ id: string; name: string }> {
  const drives = await api<Array<{ id: string; name: string; teamBrainDrive?: true }>>('/api/volume-definitions')
  const ready = drives.find((candidate) => candidate.teamBrainDrive)
  if (ready) return { id: ready.id, name: ready.name }
  const mount = await api<{ volumeId: string; volumeName: string }>(`/api/agents/${agent.slug}/mounts`, {
    method: 'POST',
    body: JSON.stringify({ type: 'local', config: { path: folder }, visibility: 'public' }),
  })
  const drive = { id: mount.volumeId, name: mount.volumeName }
  const { setup } = await api<{ setup: { setupId: string } }>('/api/team-brain/setup', { method: 'POST' })
  await api('/api/team-brain/setup', {
    method: 'PATCH',
    body: JSON.stringify({
      setupId: setup.setupId,
      agent: { slug: agent.slug, replaces: null },
      drive: { volumeId: drive.id, location: 'local', replaces: null },
    }),
  })
  await api('/api/team-brain/setup/ready', { method: 'POST', body: JSON.stringify({ setupId: setup.setupId }) })
  return drive
}

async function seedSessions(agent: ApiAgent): Promise<Array<{ id: string; message: string }>> {
  const sessions: Array<{ id: string; message: string }> = []
  for (const message of SESSION_MESSAGES) {
    const listed = await api<Array<{ id: string; name: string }>>(`/api/agents/${agent.slug}/sessions`)
    const found = await findSessionWithMessage(agent, listed, message)
    if (found) {
      sessions.push({ id: found, message })
      continue
    }
    const created = await api<{ id: string }>(`/api/agents/${agent.slug}/sessions`, { method: 'POST', body: JSON.stringify({ message }) })
    // The mock container writes the user line and its reply; wait until both are in the transcript.
    await waitFor(`the reply in session ${created.id}`, async () => {
      const messages = await api<Array<{ type: string; content?: unknown }>>(`/api/agents/${agent.slug}/sessions/${created.id}/messages`)
      return messages.some((entry) => entry.type === 'assistant')
    })
    await waitFor(`session ${created.id} to go idle`, async () => {
      const all = await api<Array<{ id: string; isActive?: boolean }>>(`/api/agents/${agent.slug}/sessions`)
      return all.find((session) => session.id === created.id)?.isActive === false
    })
    sessions.push({ id: created.id, message })
    // Distinct activity times, so newest-first order is checkable.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
  }
  return sessions
}

async function findSessionWithMessage(agent: ApiAgent, listed: Array<{ id: string }>, message: string): Promise<string | null> {
  for (const session of listed) {
    const messages = await api<Array<{ type: string; content?: unknown }>>(`/api/agents/${agent.slug}/sessions/${session.id}/messages`)
    if (messages.some((entry) => entry.type === 'user' && JSON.stringify(entry.content).includes(message))) return session.id
  }
  return null
}

export async function seedWorkspace(): Promise<SeededWorkspace> {
  const folder = path.join(dataDir(), 'mcp-seed', 'team-brain-drive')
  writeDriveFiles(folder)
  const brainAgent = await findOrCreateAgent(BRAIN_AGENT_NAME)
  const researchAgent = await findOrCreateAgent(RESEARCH_AGENT_NAME)
  const drive = await setUpTeamBrain(brainAgent, folder)
  const sessions = await seedSessions(researchAgent)
  return {
    brainAgent,
    researchAgent,
    drive: { ...drive, folder },
    sessions,
    files: { index: INDEX_MD, notes: NOTES_MD, binary: BINARY },
  }
}
