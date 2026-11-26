// @libsql-must-pass
/**
 * getAuth() hands back an instance whose context has settled. On Cloudflare
 * Workers a promise a request leaves pending never settles once that request
 * ends, so an instance built by a caller that only read its options (the MCP
 * discovery routes and the /mcp challenge) failed every later caller in that
 * isolate with "This promise was created by a request that has since ended".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '../db/testing/create-test-database'
import type { AppDatabase } from '../db/drivers/types'

let handle: TestDatabase
let testDb: AppDatabase

vi.mock('@shared/lib/db', () => ({ get db() { return testDb } }))
vi.mock('@shared/lib/config/settings', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/config/settings')>(),
  getSettings: () => ({ auth: {} }),
}))

import { getAuth, resetAuth } from './index'

/** Whether `promise` has settled already: a settled promise runs its handler within a few microtasks. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  const watched = promise.then(() => { settled = true }, () => { settled = true })
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const result = settled
  await watched
  return result
}

beforeEach(async () => {
  vi.stubEnv('AUTH_MODE', 'true')
  vi.stubEnv('BETTER_AUTH_SECRET', 'get-auth-ready-test-secret-0123456789abcdef0123456789abcdef')
  vi.stubEnv('TRUSTED_ORIGINS', 'http://localhost:47891')
  vi.stubEnv('AUTH_PROVIDERS_JSON', '[]')
  vi.stubEnv('PLATFORM_TOKEN', '')
  handle = await createTestDatabase()
  testDb = handle.db
  resetAuth()
})

afterEach(async () => {
  resetAuth()
  await handle.close()
  vi.unstubAllEnvs()
})

describe('getAuth', () => {
  it('returns a new instance only once its context has settled', async () => {
    const auth = await getAuth()
    expect(await hasSettled(auth.$context)).toBe(true)
  })

  it('returns the same ready instance while its inputs are unchanged', async () => {
    const first = await getAuth()
    const second = await getAuth()
    expect(second).toBe(first)
    expect(await hasSettled(second.$context)).toBe(true)
  })
})
