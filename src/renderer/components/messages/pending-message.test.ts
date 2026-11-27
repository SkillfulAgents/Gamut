import { describe, it, expect } from 'vitest'
import { pickedUpAbovePage, type PendingMessage } from './pending-message'

describe('pickedUpAbovePage', () => {
  const mountedAt = 1_000_000
  const pending: PendingMessage = { localId: 'l1', uuid: 'u1', text: 'Start it', sentAt: mountedAt - 5000 }
  const view = { pickedUpSends: new Set(['u1']), mountedAt, hasOlder: true, dataUpdatedAt: mountedAt }

  it('clears a ghost the runtime took before this mount whose copy is above the loaded page', () => {
    expect(pickedUpAbovePage(pending, view)).toBe(true)
  })

  it.each([
    ['it has no server uuid yet', { ...pending, uuid: undefined }, view],
    ['the runtime has not taken it', pending, { ...view, pickedUpSends: new Set(['another-uuid']) }],
    ['it was sent while this list was mounted', { ...pending, sentAt: mountedAt }, view],
    ['the loaded page is the whole transcript', pending, { ...view, hasOlder: false }],
    ['no load has landed since the mount', pending, { ...view, dataUpdatedAt: mountedAt - 1 }],
  ])('keeps the ghost when %s', (_case, p, v) => {
    expect(pickedUpAbovePage(p, v)).toBe(false)
  })
})
