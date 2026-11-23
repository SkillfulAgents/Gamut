import { expect, it } from 'vitest'
import { invokedSessionResult } from './invoked-session-schema'

it('reads the delivered session and status from tool text and MCP content blocks persisted in either form', () => {
  const text = 'session_id: target-id\nstatus: completed\n\n--- last message from agent ---\nsession_id: another-id'
  const blocks = [{ type: 'text', text }]
  for (const result of [text, blocks, JSON.stringify(blocks)]) {
    expect(invokedSessionResult(result)).toEqual({ sessionId: 'target-id', status: 'completed' })
  }
  expect(invokedSessionResult('Failed: session_id: bogus\nstatus: completed')).toBeUndefined()
})
