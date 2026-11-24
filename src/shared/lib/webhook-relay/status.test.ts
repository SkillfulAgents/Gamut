import { describe, expect, it, vi } from 'vitest'
import { createFakeWebhookRelay } from './testing/fake-webhook-relay'
import { watchWebhookRelay } from './status'
import type { WebhookRelaySnapshot } from './types'

const available: WebhookRelaySnapshot = {
  available: true,
  unavailableReason: null,
  transport: 'realtime',
  lastClaimAt: null,
  lastError: 'claim failed with 403: member sub_x left',
}

describe('watchWebhookRelay', () => {
  it('publishes where things stand, then every change', () => {
    const relay = createFakeWebhookRelay()
    relay.setSnapshot({ ...available, available: false, unavailableReason: 'platform_disconnected', transport: 'idle' })
    const broadcast = vi.fn()

    watchWebhookRelay(relay, { broadcast })
    // Earlier changes went unobserved; the renderer may hold a stale status.
    expect(broadcast).toHaveBeenLastCalledWith(expect.objectContaining({ available: false, unavailableReason: 'platform_disconnected' }))

    relay.setSnapshot(available)
    expect(broadcast).toHaveBeenLastCalledWith({
      available: true,
      unavailableReason: null,
      transport: 'realtime',
      lastClaimAt: null,
    })
  })

  it('stops publishing once unsubscribed', () => {
    const relay = createFakeWebhookRelay()
    const broadcast = vi.fn()

    const stop = watchWebhookRelay(relay, { broadcast })
    stop()
    broadcast.mockClear()
    relay.setSnapshot({ ...available, transport: 'polling' })

    expect(broadcast).not.toHaveBeenCalled()
  })
})
