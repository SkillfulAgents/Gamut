import { z } from 'zod'

// Top-level `command_lifecycle` stream frames (CLI >= 2.1.206): each queued
// user message ("command") reports its state transitions — queued, started,
// completed, cancelled, discarded. `command_uuid` is the uuid the message was
// sent with (the POST response's message uuid), so the renderer can join
// frames back to its optimistic ghosts. The container also SYNTHESIZES
// terminal 'discarded' frames on interrupt for the queued messages the abort
// kills — the SDK's own frames die with the query (see the
// sdk206-queued-message-interrupt fixture, where queued frames never resolve).
//
// `state` is deliberately an open string: unknown future states must flow
// through to SSE rather than be dropped here.

const commandLifecycleSchema = z.object({
  command_uuid: z.string(),
  state: z.string(),
})

export function parseCommandLifecycle(content: unknown): { commandUuid: string; state: string } | null {
  const parsed = commandLifecycleSchema.safeParse(content)
  if (!parsed.success) return null
  return { commandUuid: parsed.data.command_uuid, state: parsed.data.state }
}

/** What became of a sent message: the runtime took it, or it never reached the runtime. Never ran is final. */
export type SendReceipt = 'picked_up' | 'never_ran'

/** The entries that name a known receipt, so one unknown value drops alone; null when not a record. */
export function parseSendReceipts(value: unknown): Record<string, SendReceipt> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const receipts: Record<string, SendReceipt> = {}
  for (const [uuid, receipt] of Object.entries(value)) {
    if (receipt === 'picked_up' || receipt === 'never_ran') receipts[uuid] = receipt
  }
  return receipts
}
