/**
 * The installation token across processes: two handles on one database file
 * stand in for two processes of a deployment. Whatever one process does to
 * the token, the other sees on its next check, because nothing is cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let current: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return current.db } }))

import { getOrCreateMcpInstallationToken, regenerateMcpInstallationToken, verifyMcpInstallationToken } from './installation-token'
import { MCP_INSTALLATION_TOKEN_RECORD_KEY } from '@shared/lib/app-records/record-schemas'
import { compareAndSetRecord, readStoredRecord } from '@shared/lib/app-records/records'

let dir: string
let processA: TestDatabase
let processB: TestDatabase

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-token-'))
  const file = path.join(dir, 'app.db')
  processA = await createTestDatabase({ file })
  processB = await createTestDatabase({ file })
})

afterEach(async () => {
  await processA.close()
  await processB.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run `work` as one of the two processes. */
async function as<T>(handle: TestDatabase, work: () => Promise<T>): Promise<T> {
  current = handle
  return work()
}

describe('the installation token', () => {
  it('is created once: both processes agree on it', async () => {
    const [a, b] = await Promise.all([
      as(processA, getOrCreateMcpInstallationToken),
      as(processB, getOrCreateMcpInstallationToken),
    ])
    expect(a).toBe(b)
    expect(await as(processB, getOrCreateMcpInstallationToken)).toBe(a)
  })

  it('a regenerate in one process stops the old token in the other at once', async () => {
    const old = await as(processA, getOrCreateMcpInstallationToken)
    expect(await as(processB, () => verifyMcpInstallationToken(old))).toBe(true)
    const fresh = await as(processA, regenerateMcpInstallationToken)
    expect(fresh).not.toBe(old)
    expect(await as(processB, () => verifyMcpInstallationToken(old))).toBe(false)
    expect(await as(processB, () => verifyMcpInstallationToken(fresh))).toBe(true)
  })

  it('compares the whole value: a prefix, a longer value and an empty one are refused', async () => {
    const token = await as(processA, getOrCreateMcpInstallationToken)
    for (const presented of ['', token.slice(0, -1), `${token}a`, token.toUpperCase()]) {
      expect(await as(processA, () => verifyMcpInstallationToken(presented))).toBe(false)
    }
  })

  it('regenerate replaces a stored value that no longer parses', async () => {
    await as(processA, getOrCreateMcpInstallationToken)
    const stored = await as(processA, () => readStoredRecord(MCP_INSTALLATION_TOKEN_RECORD_KEY))
    await as(processA, () => compareAndSetRecord(MCP_INSTALLATION_TOKEN_RECORD_KEY, stored!.revision, JSON.stringify('garbage')))
    await expect(as(processA, getOrCreateMcpInstallationToken)).rejects.toThrow()
    const fresh = await as(processA, regenerateMcpInstallationToken)
    expect(await as(processB, getOrCreateMcpInstallationToken)).toBe(fresh)
  })
})
