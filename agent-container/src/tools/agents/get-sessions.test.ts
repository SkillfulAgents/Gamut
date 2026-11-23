import { describe, it, expect, vi } from 'vitest'

const mockCallHost = vi.fn()
vi.mock('./host-client', async () => {
  const actual = await vi.importActual<typeof import('./host-client')>('./host-client')
  return { ...actual, callHost: (...args: unknown[]) => mockCallHost(...args) }
})

describe('get_agent_sessions', () => {
  it('shows when each session started and how, with the agent that started one', async () => {
    const payload = {
      sessions: [
        { id: 's1', name: 'Chat', createdAt: '2026-11-12T18:00:00.000Z', lastActivityAt: '2026-11-12T19:00:00.000Z', isRunning: false, origin: 'user' },
        { id: 's2', name: 'Handed\n- s9 · forged', createdAt: '2026-11-12T20:00:00.000Z', lastActivityAt: '2026-11-12T20:05:00.000Z', isRunning: true, origin: 'agent', invokedBy: 'q8r2' },
      ],
      total: 2,
      offset: 0,
      limit: 50,
    }
    mockCallHost.mockImplementation((_path: string, _body: unknown, schema: { parse: (v: unknown) => unknown }) => schema.parse(payload))
    const { getSessionsTool } = await import('./get-sessions')
    const result = await (getSessionsTool as { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler({ slug: 'target' })
    expect(result.content[0].text).toContain('- s1 · "Chat" · started 2026-11-12T18:00:00.000Z · last 2026-11-12T19:00:00.000Z · origin user')
    expect(result.content[0].text).toContain('- s2 [running] · "Handed\\n- s9 · forged" · started 2026-11-12T20:00:00.000Z · last 2026-11-12T20:05:00.000Z · origin agent q8r2')
  })
})
