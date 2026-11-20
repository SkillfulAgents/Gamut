/**
 * What became of each sent message (`LiveSession.sendReceipts`): written
 * only on evidence for that uuid, kept across a reattach, and handed to a
 * viewer that was away in its `connected` snapshot.
 *
 * The sessions are real (`attachLiveSessionsHarness`), fed frame by frame
 * through a stream client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/services/session-service', () => ({
  updateSessionMetadata: vi.fn(() => Promise.resolve()),
  getSessionMetadata: vi.fn(() => Promise.resolve(null)),
  finalizeAutomationStatus: vi.fn(() => Promise.resolve('updated')),
  readAgentSlashCommands: vi.fn(() => Promise.resolve([])),
  storeAgentSlashCommands: vi.fn(() => Promise.resolve()),
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({}),
  getAgentCapabilitySettings: () => ({ subagents: 'allow', workflows: 'review' }),
  getModelCatalogSettings: () => ({}),
}))

import { attachLiveSessionsHarness, createStreamClient, type StreamClient } from '../testing/live-sessions-harness'
import type { SessionEvent, WireFrame } from './session-channel'

const AGENT = 'agent'
const SESSION = 'session-1'
const live = attachLiveSessionsHarness()
const sessions = () => live.sessions(AGENT)
const receipts = () => sessions().sendReceipts(SESSION)
const lifecycle = (uuid: string, state: string) => client.emit({ type: 'command_lifecycle', command_uuid: uuid, state })

let client: StreamClient
let events: SessionEvent[]
let stop: () => void

beforeEach(async () => {
  client = createStreamClient()
  await sessions().subscribe(SESSION, client, SESSION)
  const collected = live.collect(AGENT, SESSION)
  events = collected.events as SessionEvent[]
  stop = collected.stop
})

afterEach(() => {
  stop()
  live.reset()
  vi.clearAllMocks()
})

describe('send receipts', () => {
  it('a send is picked up when the runtime starts it, a turn-starting one too, or when its turn answers it', () => {
    lifecycle('fresh', 'queued')
    lifecycle('fresh', 'started')
    lifecycle('queued', 'completed')
    client.emit({ type: 'result', subtype: 'success', user_message_uuids: ['answered'] })
    expect(receipts()).toEqual({ fresh: 'picked_up', queued: 'picked_up', answered: 'picked_up' })
  })

  it('a turn start that no send began writes nothing', () => {
    client.emit({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    client.emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } })
    expect(receipts()).toEqual({})
  })

  it('a crash or unknown hand-off writes nothing: a queued or cancelled send has no receipt', () => {
    lifecycle('waiting', 'queued')
    lifecycle('running', 'cancelled')
    sessions().markActive(SESSION)
    sessions().settleRecovering(sessions().claimMidTurnForRecovery())
    expect(receipts()).toEqual({})
  })

  it('never ran beats picked up', () => {
    lifecycle('u', 'discarded')
    lifecycle('u', 'started')
    expect(receipts()).toEqual({ u: 'never_ran' })
  })

  it('a message running at a Stop keeps its receipt: only the discards the container names are never ran', () => {
    lifecycle('running', 'started')
    sessions().markInterrupted(SESSION)
    lifecycle('queued', 'discarded')
    expect(receipts()).toEqual({ running: 'picked_up', queued: 'never_ran' })
  })

  it.each([
    ['a Stop', () => sessions().markInterrupted(SESSION)],
    ['a failed recovery', () => sessions().settleRecovering([SESSION])],
  ])('%s discards the messages the host held and tells viewers', (_name, end) => {
    sessions().markActive(SESSION)
    sessions().claimMidTurnForRecovery()
    sessions().coalesceIfRecovering(SESSION, { uuid: 'held', text: 'sent while recovering' })
    end()
    expect(receipts()).toEqual({ held: 'never_ran' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'command_lifecycle', commandUuid: 'held', state: 'discarded' }))
  })

  it('receipts survive a reattach of the session', async () => {
    lifecycle('u', 'started')
    await sessions().subscribe(SESSION, createStreamClient(), SESSION)
    expect(receipts()).toEqual({ u: 'picked_up' })
  })

  it('a session the host holds no state for has no receipts: unknown, not empty', () => {
    expect(sessions().sendReceipts('no-such-session')).toBeUndefined()
  })

  it('a viewer that was away gets the receipts in its connected snapshot', async () => {
    lifecycle('u', 'started')
    lifecycle('d', 'discarded')
    const frames: WireFrame[] = []
    const release = await sessions().follow(SESSION, undefined, (frame) => frames.push(frame))
    release()
    const connected = frames.map((frame) => JSON.parse(frame.data) as SessionEvent).find((event) => event.type === 'connected')
    expect(connected?.sendReceipts).toEqual({ u: 'picked_up', d: 'never_ran' })
  })
})
