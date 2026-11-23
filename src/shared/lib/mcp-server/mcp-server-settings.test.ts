import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

import { getSettings, mutateSettings } from '@shared/lib/config/settings'
import { mcpServerSettingsSchema } from './mcp-server-settings-schema'
import { isMcpServerEnabledFrom, mcpServerReachFrom, setMcpServerReach } from './mcp-server-settings'

beforeEach(async () => {
  handle = await createTestDatabase()
})

afterEach(async () => {
  await handle.close()
  vi.unstubAllEnvs()
})

describe('MCP server settings', () => {
  it('reach defaults to this computer, for fresh settings and for stored ones written before the field', async () => {
    expect(mcpServerReachFrom(await getSettings())).toBe('this-computer')
    await mutateSettings((s) => { s.mcpServer = { enabled: true } })
    expect(mcpServerReachFrom(await getSettings())).toBe('this-computer')
  })

  it('stores a chosen reach and keeps the switch beside it', async () => {
    await mutateSettings((s) => { s.mcpServer = { enabled: false } })
    expect(await setMcpServerReach('network')).toBe('network')
    const settings = await getSettings()
    expect(settings.mcpServer).toEqual({ enabled: false, reach: 'network' })
    expect(isMcpServerEnabledFrom(settings)).toBe(false)
  })

  it('validates the field at the boundary: an unknown reach or field is refused', () => {
    expect(mcpServerSettingsSchema.safeParse({ reach: 'network' }).success).toBe(true)
    expect(mcpServerSettingsSchema.safeParse({ reach: 'everyone' }).success).toBe(false)
    expect(mcpServerSettingsSchema.safeParse({ reach: 'network', other: 1 }).success).toBe(false)
  })

  it('the switch defaults by mode: on without auth mode, off with it', () => {
    expect(isMcpServerEnabledFrom({})).toBe(true)
    vi.stubEnv('AUTH_MODE', 'true')
    expect(isMcpServerEnabledFrom({})).toBe(false)
  })
})
