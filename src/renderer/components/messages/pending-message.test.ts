import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@renderer/test/factories'
import { savedSendIds, settlePending, type PendingMessage } from './pending-message'

const MOUNTED_AT = 1_000_000
const before: PendingMessage = { localId: 'b', uuid: 'u-before', text: 'Start it', sentAt: MOUNTED_AT - 5000 }
const here: PendingMessage = { localId: 'h', uuid: 'u-here', text: 'next', sentAt: MOUNTED_AT + 5000 }
const settle = (over: Partial<Parameters<typeof settlePending<PendingMessage>>[0]>) =>
  settlePending<PendingMessage>({
    pending: [before, here],
    saved: new Set<string>(),
    receipts: {},
    mountedAt: MOUNTED_AT,
    loadedSinceMount: true,
    pageTruncated: true,
    ...over,
  })
const ids = (r: ReturnType<typeof settlePending<PendingMessage>>) => ({ appeared: r.appeared.map((p) => p.localId), neverRan: r.neverRan.map((p) => p.localId) })

describe('savedSendIds', () => {
  it('holds each message id and every send the runtime merged into a user message', () => {
    const merged = { ...createUserMessage({ id: 'line' }), mergedSendUuids: ['s1', 's2'] }
    expect([...savedSendIds([merged, createAssistantMessage({ id: 'a' })])].sort()).toEqual(['a', 'line', 's1', 's2'])
  })
})

describe('settlePending', () => {
  it('clears a message whose saved copy is loaded, by its id or a merged id', () => {
    expect(ids(settle({ saved: new Set(['u-before', 'u-here']) }))).toEqual({ appeared: ['b', 'h'], neverRan: [] })
  })

  it('a message sent before this view waits for the host receipts, even with its copy loaded', () => {
    const saved = new Set(['u-before', 'u-here'])
    expect(ids(settle({ saved, receipts: null }))).toEqual({ appeared: ['h'], neverRan: [] })
    expect(ids(settle({ saved, receipts: { 'u-before': 'never_ran' } }))).toEqual({ appeared: ['h'], neverRan: ['b'] })
  })

  it('a picked-up receipt clears only a message sent before this view, once a load since the mount missed it on a truncated page', () => {
    const receipts = { 'u-before': 'picked_up', 'u-here': 'picked_up' } as const
    expect(ids(settle({ receipts }))).toEqual({ appeared: ['b'], neverRan: [] })
    expect(ids(settle({ receipts, loadedSinceMount: false })).appeared).toEqual([])
    expect(ids(settle({ receipts, pageTruncated: false })).appeared).toEqual([])
    expect(ids(settle({ receipts, saved: null })).appeared).toEqual([])
  })

  it('never ran clears the message for its text to go back, from a receipt or a live discard', () => {
    expect(ids(settle({ receipts: { 'u-before': 'never_ran', 'u-here': 'never_ran' } }))).toEqual({ appeared: [], neverRan: ['b', 'h'] })
  })

  it('never ran wins over a loaded copy: a queued message is saved before a Stop drops it', () => {
    expect(ids(settle({ saved: new Set(['u-here']), receipts: { 'u-here': 'never_ran' } }))).toEqual({ appeared: [], neverRan: ['h'] })
  })

  it('a message with no receipt, or no server id yet, stays pending, and an empty receipt list changes nothing', () => {
    const noId: PendingMessage = { localId: 'n', text: 'sending', sentAt: MOUNTED_AT + 1 }
    expect(ids(settle({ pending: [before, here, noId] }))).toEqual({ appeared: [], neverRan: [] })
  })
})
