// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolCall, createUserMessage } from '@renderer/test/factories'
import { INVOKE_AGENT_TOOL, type InvokedSession } from '@shared/lib/services/x-agent/invoked-session-schema'
import { useTurnAgentCalls } from './use-turn-agent-calls'

const receipts = vi.fn<() => InvokedSession[]>()
vi.mock('./use-invocations', () => ({ useInvocationList: () => ({ data: receipts() }) }))
vi.mock('./use-agents', async importOriginal => ({
  ...await importOriginal<typeof import('./use-agents')>(),
  useAgents: () => ({ data: [{ slug: 'analyst', name: 'Analyst' }] }),
}))
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...await importOriginal<typeof import('@tanstack/react-query')>(),
  useQueries: () => [{ data: { isActive: true } }],
}))

describe('the working indicator during a synchronous invoke', () => {
  it('opens the delivered child before the tool returns and ignores receipts from earlier turns', () => {
    const messages = [
      createUserMessage({ createdAt: new Date('2026-01-01T01:00:00Z') }),
      createAssistantMessage({ toolCalls: [createToolCall({
        id: 'invoke', name: INVOKE_AGENT_TOOL, input: { slug: 'analyst', prompt: 'Inspect', sync: true }, result: undefined,
      })] }),
    ]
    const current = { agentSlug: 'analyst', sessionId: 'child', prompt: 'Inspect', calledAt: '2026-01-01T01:00:01Z' }
    const older = { ...current, sessionId: 'older', calledAt: '2026-01-01T00:59:59Z' }
    receipts.mockReturnValue([older])
    const view = renderHook(() => useTurnAgentCalls(messages, 'caller', 'parent', true))
    expect(view.result.current).toMatchObject([{ name: 'Analyst', state: 'working', sessionId: null }])

    receipts.mockReturnValue([older, current])
    view.rerender()
    expect(view.result.current).toMatchObject([{ name: 'Analyst', state: 'working', sessionId: 'child' }])
  })
})
