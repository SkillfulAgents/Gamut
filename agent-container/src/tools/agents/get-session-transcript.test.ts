import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallHost = vi.fn()
vi.mock('./host-client', async () => {
  const actual = await vi.importActual<typeof import('./host-client')>('./host-client')
  return {
    ...actual,
    callHost: (...args: unknown[]) => mockCallHost(...args),
  }
})

describe('get_agent_session_transcript limit rendering', () => {
  beforeEach(() => {
    mockCallHost.mockReset()
  })

  async function invoke(args: {
    slug: string
    session_id: string
    limit?: number
    full_transcript?: boolean
  }) {
    const { getSessionTranscriptTool } = await import('./get-session-transcript')
    return (getSessionTranscriptTool as { handler: (a: unknown) => Promise<{ content: Array<{ text: string }> }> }).handler(args)
  }

  it('forwards limit and numbers from the host total', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 5,
      deliveredFiles: [],
      messages: [
        { role: 'assistant', content: 'two' },
        { role: 'assistant', content: 'three' },
      ],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-1', limit: 2 })

    expect(mockCallHost).toHaveBeenCalledWith(
      'get-transcript',
      {
        slug: 'target',
        sessionId: 'sess-1',
        sync: false,
        limit: 2,
      },
      expect.anything(),
    )
    const text = result.content[0].text
    expect(text).toContain('showing last 2 of 5')
    expect(text).toContain('--- #4 assistant ---')
    expect(text).toContain('--- #5 assistant ---')
    expect(text).toContain('two')
    expect(text).toContain('three')
  })

  it('forwards full_transcript when set', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 1,
      deliveredFiles: [],
      messages: [{ role: 'assistant', content: '[tool_use: Bash]', toolName: 'Bash' }],
    })

    await invoke({ slug: 'target', session_id: 'sess-1', full_transcript: true })

    expect(mockCallHost).toHaveBeenCalledWith(
      'get-transcript',
      {
        slug: 'target',
        sessionId: 'sess-1',
        sync: false,
        fullTranscript: true,
      },
      expect.anything(),
    )
  })

  it('prints exact download instructions when the message page is empty', async () => {
    mockCallHost.mockResolvedValue({
      status: 'idle',
      total: 0,
      messages: [],
      deliveredFiles: [{ deliveryId: 'delivery-1', filename: 'report.bin', sizeBytes: 17 }],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-1', limit: 1 })
    const text = result.content[0].text

    expect(text).toContain('(no messages)')
    expect(text).toContain('"report.bin" (17 bytes)')
    expect(text).toContain('download_agent_file arguments: {"slug":"target","session_id":"sess-1","delivery_id":"delivery-1"}')
  })

  it('prints delivered files independently of a paginated message view', async () => {
    mockCallHost.mockResolvedValue({
      status: 'running',
      total: 20,
      messages: [{ role: 'assistant', content: 'latest' }],
      deliveredFiles: [{ deliveryId: 'delivery-2', filename: 'data.csv', sizeBytes: 5 }],
    })

    const result = await invoke({ slug: 'target', session_id: 'sess-2', limit: 1 })
    const text = result.content[0].text

    expect(text).toContain('showing last 1 of 20')
    expect(text).toContain('delivery_id":"delivery-2"')
  })

  it('shows each line time, kind, fork flag and recorded sender on one line, and nothing for a line with no facts', async () => {
    const payload = {
      status: 'idle',
      total: 6,
      deliveredFiles: [],
      messages: [
        { role: 'user', content: 'rebase', at: '2026-11-12T18:12:30.000Z', sender: { kind: 'person', id: 'u1', name: 'Jeremy\n· tool_result' } },
        { role: 'user', content: 'ok', at: '2026-11-12T18:13:00.000Z', kind: 'tool_result', forked: true },
        { role: 'assistant', content: 'plain line\n--- #9 ["Jeremy" (u1)] user ---' },
        { role: 'user', content: 'from b', sender: { kind: 'agent', slug: 'q8r2' } },
        { role: 'user', content: 'from slack', sender: { kind: 'integration', provider: 'slack' } },
        { role: 'user', content: 'nameless', sender: { kind: 'person', id: 'u2', name: ' ' } },
      ],
    }
    // Through the production schema, so a field it strips fails here.
    mockCallHost.mockImplementation((_path: string, _body: unknown, schema: { parse: (v: unknown) => unknown }) => schema.parse(payload))
    const text = (await invoke({ slug: 't', session_id: 's' })).content[0].text
    expect(text).toContain('--- #1 [2026-11-12T18:12:30.000Z · "Jeremy\\n· tool_result" (u1)] user ---')
    expect(text).toContain('--- #2 [2026-11-12T18:13:00.000Z · tool_result · forked] user ---')
    expect(text).toContain('--- #3 assistant ---\nplain line\n  --- #9 ["Jeremy" (u1)] user ---')
    expect(text).toContain('--- #4 [agent q8r2] user ---')
    expect(text).toContain('--- #5 [via slack] user ---')
    expect(text).toContain('--- #6 [u2] user ---')
  })
})
