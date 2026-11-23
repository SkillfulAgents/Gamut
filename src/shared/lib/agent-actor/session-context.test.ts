import type { SessionUsage } from '../types/agent'
import { describe, expect, it, vi } from 'vitest'
import { readSessionContext, saveSettledContext } from './session-context'
import { createInMemorySessionStore } from './testing/in-memory-session-store'
import type { ContextBreakdown, RuntimeContext, SavedContext } from '../container/context-breakdown-schema'

const usage = { totalTokens: 500, contextWindow: 2000 }
const breakdown: ContextBreakdown = {
  totalTokens: usage.totalTokens, rawMaxTokens: usage.contextWindow, percentage: 25,
  categories: [{ id: 'messages', name: 'Messages', kind: 'used', tokens: 500 }],
  mcpTools: [], memoryFiles: [],
}
const first: SavedContext = { kind: 'estimate', revision: 'a', measuredAt: '2026-05-01T12:00:00.000Z', breakdown }
const second: SavedContext = { ...first, revision: 'b', measuredAt: '2026-05-01T13:00:00.000Z' }

describe('session context measurements', () => {
  it('reads saved estimates and legacy totals without contacting a runtime', async () => {
    const store = createInMemorySessionStore('atlas')
    const measure = vi.fn()
    await saveSettledContext(store, 's', usage, first, false)
    expect(await readSessionContext(store, 's', false, measure)).toMatchObject({ source: 'saved-estimate', breakdown })
    const oldUsage = { totalTokens: 442, contextWindow: 0 }
    await saveSettledContext(store, 's', oldUsage, undefined, false)
    expect(await readSessionContext(store, 's', false, measure)).toEqual({ breakdown: null, source: 'saved-usage', usage: oldUsage })
    expect(measure).not.toHaveBeenCalled()
  })

  it('normalizes missing fields in permissive legacy metadata', async () => {
    const store = createInMemorySessionStore('atlas')
    await store.index.update('s', () => ({ lastUsage: { totalTokens: 120 } as SessionUsage }))
    const idle = vi.fn(async () => ({ breakdown: null }))
    expect(await readSessionContext(store, 's', false, idle)).toEqual({
      source: 'saved-usage', breakdown: null, usage: { totalTokens: 120, contextWindow: 0 },
    })
    expect(idle).not.toHaveBeenCalled()
    await store.index.update('s', () => ({ lastUsage: { contextWindow: 2000 } as SessionUsage }))
    expect(await readSessionContext(store, 's', false, idle)).toEqual({ breakdown: null })
  })

  it('keeps a precise count for its revision through a reconnect and a failed refresh', async () => {
    const store = createInMemorySessionStore('atlas')
    await saveSettledContext(store, 's', usage, first, false)
    const exact = { ...breakdown, totalTokens: 548 }
    expect(await readSessionContext(store, 's', true, async () => ({ breakdown: exact, revision: 'a' })))
      .toMatchObject({ source: 'live', breakdown: exact })
    expect(await saveSettledContext(store, 's', usage, first, true)).toBe(false)
    expect(await readSessionContext(store, 's', true, async () => { throw Error('query ended') }))
      .toMatchObject({ source: 'saved-full', refreshFailed: true, breakdown: exact })
    await saveSettledContext(store, 's', usage, second, false)
    expect(await saveSettledContext(store, 's', usage, first, true)).toBe(false)
    expect(await readSessionContext(store, 's', true, async () => ({ breakdown: null })))
      .toMatchObject({ source: 'saved-estimate', capturedAt: second.measuredAt, breakdown })
  })

  it('returns a newer saved revision if a precise read lost a race to compaction', async () => {
    const store = createInMemorySessionStore('atlas')
    await saveSettledContext(store, 's', usage, first, false)
    const measure = async (): Promise<RuntimeContext> => {
      await saveSettledContext(store, 's', usage, second, false)
      return { breakdown, revision: 'a' }
    }
    expect(await readSessionContext(store, 's', true, measure)).toMatchObject({
      source: 'saved-estimate', capturedAt: second.measuredAt,
    })
    expect((await store.index.get('s'))?.meta?.lastContext).toEqual(second)
  })

  it('shows a live count before its revision settles without overwriting the previous turn', async () => {
    const store = createInMemorySessionStore('atlas')
    await saveSettledContext(store, 's', usage, first, false)
    const exact = { ...breakdown, totalTokens: 618 }
    expect(await readSessionContext(store, 's', true, async () => ({ breakdown: exact, revision: 'new-turn' })))
      .toMatchObject({ source: 'live', breakdown: exact })
    expect((await store.index.get('s'))?.meta?.lastContext).toEqual(first)
  })
})
