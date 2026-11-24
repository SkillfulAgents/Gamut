import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { eq } from 'drizzle-orm'
import * as schema from '@shared/lib/db/schema'
import type { AppDatabase } from '@shared/lib/db/drivers/types'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let testDb: AppDatabase
let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))

import { ensureDirectory, getAgentDir, getAgentInstructionsPath } from '@shared/lib/utils/file-storage'
import { BaseAgentActor } from './base-agent-actor'
import { LocalAgentActor, type LocalActorParts } from './local-agent-actor'
import { createRecordingHostPort } from './testing/recording-host-port'

let dataDir: string
let previousDataDir: string | undefined

/** A container layer whose agents have no container running. */
const parts = () =>
  ({
    containers: {
      createRuntime: () => ({
        isStopping: () => false,
        isStarting: () => false,
        syncAgentStatus: async () => ({ status: 'stopped', port: null }),
        getCachedInfo: () => ({ status: 'stopped', port: null }),
        getClient: async () => ({ isDefinitelyStopped: async () => true }),
        dispose: () => {},
      }),
    },
    host: createRecordingHostPort().port,
  }) as unknown as LocalActorParts

async function writeAgentDirectory(slug: string): Promise<void> {
  await ensureDirectory(path.join(getAgentDir(slug), 'workspace'))
  await fs.promises.writeFile(getAgentInstructionsPath(slug), '---\nname: Research\n---\nBody')
}

const sessionsOf = (slug: string) =>
  testDb.select().from(schema.agentSessions).where(eq(schema.agentSessions.agentSlug, slug)).all()

beforeEach(async () => {
  handle = await createTestDatabase()
  testDb = handle.db
  dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'local-agent-actor-test-'))
  previousDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = dataDir
})

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
  else process.env.SUPERAGENT_DATA_DIR = previousDataDir
  await handle.close()
  await fs.promises.rm(dataDir, { recursive: true, force: true })
})

describe('LocalAgentActor', () => {
  it('is the base actor, kept on this machine', async () => {
    const actor = new LocalAgentActor('research', parts())
    await actor.ready()

    expect(actor).toBeInstanceOf(BaseAgentActor)
    await actor.dispose()
  })

  describe('delete', () => {
    it("removes the agent's directory and its session index, and nothing of another agent", async () => {
      await writeAgentDirectory('research')
      await writeAgentDirectory('writer')
      await testDb.insert(schema.agentSessions).values([
        { agentSlug: 'research', sessionId: 's1', metadata: '{"name":"Its session"}' },
        { agentSlug: 'research', sessionId: 's2', metadata: null, transcriptMtimeMs: 1, transcriptBirthtimeMs: 0, transcriptSize: 1 },
        { agentSlug: 'writer', sessionId: 's1', metadata: '{"name":"Another agent\'s"}' },
      ]).run()
      const actor = new LocalAgentActor('research', parts())
      await actor.ready()

      await actor.delete()

      expect(fs.existsSync(getAgentDir('research'))).toBe(false)
      expect(await sessionsOf('research')).toEqual([])
      expect(fs.existsSync(getAgentDir('writer'))).toBe(true)
      expect(await sessionsOf('writer')).toHaveLength(1)
      await actor.dispose()
    })

    it('succeeds for an agent that stored nothing', async () => {
      const actor = new LocalAgentActor('research', parts())
      await actor.ready()

      await expect(actor.delete()).resolves.toBeUndefined()
      await actor.dispose()
    })

    it('fails with its session index still there when the directory cannot be removed, so the delete can be tried again', async () => {
      await writeAgentDirectory('research')
      await testDb.insert(schema.agentSessions).values({ agentSlug: 'research', sessionId: 's1', metadata: '{"name":"Its session"}' }).run()
      const actor = new LocalAgentActor('research', parts())
      await actor.ready()
      // A read-only parent refuses to unlink the agent directory itself.
      const agentsDir = path.dirname(getAgentDir('research'))
      await fs.promises.chmod(agentsDir, 0o555)

      try {
        await expect(actor.delete()).rejects.toThrow()
        expect(fs.existsSync(getAgentDir('research'))).toBe(true)
        expect(await sessionsOf('research')).toHaveLength(1)
      } finally {
        await fs.promises.chmod(agentsDir, 0o755)
      }

      await actor.delete()
      expect(fs.existsSync(getAgentDir('research'))).toBe(false)
      expect(await sessionsOf('research')).toEqual([])
      await actor.dispose()
    })
  })
})
