/**
 * What a tool lets a person see, decided by their own access: drive
 * visibility (public drives and their own, `selectableVolumes`) and their
 * `agent_acl` role. The tools are mode-agnostic, so this runs them for
 * auth-mode people directly (the endpoint is served there once OAuth lands).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { agentAcl, agents, user } from '@shared/lib/db/schema'
import { runtimeCapabilities } from '@shared/lib/facts/capabilities'
import { declareServerCapabilities } from '@shared/lib/facts/server-facts'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))
vi.mock('@shared/lib/auth/config', async (original) => ({
  ...(await original<typeof import('@shared/lib/auth/config')>()),
  getAppBaseUrl: async () => 'https://gamut.test',
}))
// Not spreading the original: importing it from inside this factory can bind
// the actor package's re-export to the real registry before the mock lands.
vi.mock('@shared/lib/agent-actor/registry', () => ({
  agentRegistry: {
    get: (slug: string) => ({
      live: async () => ({ container: { status: 'stopped', port: null, healthWarnings: [], stale: false, idleSince: null }, activeSessionIds: [] }),
      sessions: {
        list: async () => [{ id: 's1', agentSlug: slug, name: 'One', createdAt: new Date(1), lastActivityAt: new Date(2) }],
        readMetadata: async () => ({}),
        isKnown: async (id: string) => id === 's1',
        live: async () => ({ isActive: false, isAwaitingInput: false }),
      },
      messages: { transcriptView: async () => ({ messages: [{ role: 'user', content: 'hi' }], total: 1, deliveredFiles: [] }) },
    }),
  },
}))

import { createVolumeDefinition } from '@shared/lib/services/volume-service'
import type { McpCallContext } from '../context'
import { runTool, jsonResult } from '../tool-result'
import { listDriveFiles, listDrives, readDriveFile } from './drive-tools'
import { listAgents } from './agent-tools'
import { listSessions, readSession } from './session-tools'
import { detachedCall, type McpToolDefinition } from '../tool-definition'

let root: string
let privateDrive: string
let publicDrive: string

function person(userId: string, isAdmin = false): McpCallContext {
  return { userId, isAdmin, publicBaseUrl: 'https://gamut.test', credential: { kind: 'installation-token' }, scopes: ['read', 'run'] }
}

async function call(tool: McpToolDefinition<any, any>, args: Record<string, unknown>, ctx: McpCallContext) {
  const result = await runTool(tool.name, async () => jsonResult(await tool.handler(tool.input.parse(args), ctx, detachedCall())))
  return { error: result.isError ? (result.content[0] as { text: string }).text : null, value: result.structuredContent as any }
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  declareServerCapabilities(runtimeCapabilities({ os: 'darwin', distribution: 'direct' }))
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-access-')))
  for (const name of ['private', 'public']) {
    fs.mkdirSync(path.join(root, name))
    fs.writeFileSync(path.join(root, name, 'note.md'), `${name} note`)
  }
  handle = await createTestDatabase()
  await handle.db.insert(user).values([
    { id: 'alice', name: 'Alice', email: 'alice@example.com' },
    { id: 'bob', name: 'Bob', email: 'bob@example.com' },
    { id: 'admin', name: 'Admin', email: 'admin@example.com', role: 'admin' },
  ]).run()
  await handle.db.insert(agents).values({ slug: 'alpha', name: 'Alpha', createdAt: new Date() }).run()
  await handle.db.insert(agentAcl).values({ id: 'a', userId: 'alice', agentSlug: 'alpha', role: 'viewer', createdAt: new Date() }).run()
  privateDrive = (await createVolumeDefinition({ type: 'local', config: { path: path.join(root, 'private') }, name: 'Alice private' }, { userId: 'alice', admin: false })).id
  publicDrive = (await createVolumeDefinition({ type: 'local', config: { path: path.join(root, 'public') }, name: 'Shared', visibility: 'public' }, { userId: 'admin', admin: true })).id
})

afterEach(async () => {
  declareServerCapabilities(null)
  await backgroundSettled()
  await handle.close()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('drive visibility', () => {
  it('lists a private drive to its owner only', async () => {
    const names = async (userId: string) => (await call(listDrives, {}, person(userId))).value.drives.map((d: { name: string }) => d.name).sort()
    expect(await names('alice')).toEqual(['Alice private', 'Shared'])
    expect(await names('bob')).toEqual(['Shared'])
    // An admin sees public drives and their own, as in the drives page.
    expect(await names('admin')).toEqual(['Shared'])
  })

  it('does not let another person list or read a private drive, by id or by name', async () => {
    for (const drive of [privateDrive, 'Alice private']) {
      const listed = await call(listDriveFiles, { drive }, person('bob'))
      expect(listed.error).toMatch(/not found, or you cannot see it/)
      const read = await call(readDriveFile, { drive, path: 'note.md' }, person('bob'))
      expect(read.error).toMatch(/not found, or you cannot see it/)
    }
    expect((await call(readDriveFile, { drive: privateDrive, path: 'note.md' }, person('alice'))).value.content).toBe('private note')
    expect((await call(readDriveFile, { drive: publicDrive, path: 'note.md' }, person('bob'))).value.content).toBe('public note')
  })
})

describe('agent roles', () => {
  it('lists only the agents a person has a role on', async () => {
    expect((await call(listAgents, {}, person('alice'))).value.agents.map((a: { name: string }) => a.name)).toEqual(['Alpha'])
    expect((await call(listAgents, {}, person('bob'))).value.agents).toEqual([])
    expect((await call(listAgents, {}, person('admin', true))).value.agents).toHaveLength(1)
  })

  it('lets a viewer read sessions and transcripts, and refuses someone with no role', async () => {
    expect((await call(listSessions, { agent: 'alpha' }, person('alice'))).value.sessions).toHaveLength(1)
    expect((await call(readSession, { agent: 'alpha', session_id: 's1' }, person('alice'))).value.messages).toHaveLength(1)
    expect((await call(listSessions, { agent: 'alpha' }, person('bob'))).error).toMatch(/viewer role/)
    expect((await call(readSession, { agent: 'alpha', session_id: 's1' }, person('bob'))).error).toMatch(/viewer role/)
    // Knowing a session id is not access.
    expect((await call(readSession, { agent: 'alpha', session_id: 'nope' }, person('bob'))).error).toMatch(/viewer role/)
  })
})
