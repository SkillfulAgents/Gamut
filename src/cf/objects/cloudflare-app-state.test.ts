import { describe, expect, it } from 'vitest'
import type { WorkerWebSocket } from 'cloudflare:workers'
import { describeAppStateConformance } from '@shared/lib/app-state/testing/conformance'
import { backgroundSettled } from '@shared/lib/background'
import { CloudflareAppState, type KeyPolicy } from './cloudflare-app-state'
import { memoryHub, memorySql, namespaceOf, testObject } from './testing/app-state-object'

describeAppStateConformance('CloudflareAppState', () => {
  const object = testObject()
  const objects = namespaceOf(object)
  const hub = memoryHub()
  return {
    open: (scope) => new CloudflareAppState(objects, { scope, hub }),
    advance: (ms) => {
      object.clock += ms
    },
    settled: () => backgroundSettled(),
  }
})

function socket(channels: string[]) {
  const sent: string[] = []
  return { sent, send: (message: string) => sent.push(message), deserializeAttachment: () => ({ channels }) } as unknown as WorkerWebSocket & { sent: string[] }
}

describe('AppStateDurableObject', () => {
  it('sends an event only to the sockets subscribed to its channel', () => {
    const sockets = [socket(['events:a', 'events:b']), socket(['events:b']), socket(['events:c'])]
    const object = testObject(memorySql(), sockets)

    expect(object.publish('events:b', '{"n":1}')).toEqual({ delivered: 2 })

    const message = JSON.stringify({ c: 'events:b', j: '{"n":1}' })
    expect(sockets.map((s) => s.sent)).toEqual([[message], [message], []])
  })

  it('accepts a subscription socket only on its path, with at least one channel', async () => {
    const object = testObject()
    const upgrade = { Upgrade: 'websocket' }
    expect((await object.fetch(new Request('https://app-state/other', { headers: upgrade }))).status).toBe(404)
    expect((await object.fetch(new Request('https://app-state/subscribe'))).status).toBe(404)
    expect((await object.fetch(new Request('https://app-state/subscribe', { headers: upgrade }))).status).toBe(400)
  })

  it('never issues a revision an earlier instance of the object issued', () => {
    const sql = memorySql()
    const policy: KeyPolicy = { name: 'test:lasting', consistency: 'strong', expiry: { ttlMs: null, onUpdate: 'keep' } }
    const first = testObject(sql)
    const before = first.write('k', '"a"', policy)

    const after = testObject(sql).write('k', '"a"', policy)

    expect(after.revision).not.toBe(before.revision)
    expect(first.compareAndSet('k', before.revision, '"b"', policy)).toMatchObject({ ok: false })
  })
})
