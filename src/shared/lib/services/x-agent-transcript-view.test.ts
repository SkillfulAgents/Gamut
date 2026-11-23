import { describe, expect, it } from 'vitest'
import {
  collectDeliveredFiles,
  findDeliveredFile,
  readTranscriptView,
  toTranscriptView,
  type CompactedMessage,
} from './x-agent-transcript-view'

type Entry = Parameters<typeof collectDeliveredFiles>[0][number]

/** The transcript as the actor hands it over: one entry at a time. */
async function* stream(entries: Entry[]): AsyncGenerator<Entry> {
  for (const entry of entries) yield entry
}

const assistantEntry = (
  uuid: string,
  messageId: string,
  calls: Array<{ id: string; name?: string; input: unknown }>,
): Entry => ({
  uuid,
  parentUuid: null,
  type: 'assistant',
  sessionId: 'session-1',
  timestamp: '2026-09-12T10:00:00.000Z',
  message: {
    role: 'assistant',
    id: messageId,
    content: calls.map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name ?? 'mcp__user-input__deliver_file',
      input: call.input,
    })),
  },
} as Entry)

const resultEntry = (
  uuid: string,
  toolUseId: string,
  content: unknown,
  isError = false,
  stdout?: string,
): Entry => ({
  uuid,
  parentUuid: null,
  type: 'user',
  sessionId: 'session-1',
  timestamp: '2026-09-12T10:00:01.000Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
  },
  ...(stdout !== undefined
    ? { toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false } }
    : {}),
} as Entry)

const currentResult = (sizeBytes: number, proseSize = sizeBytes): string =>
  `File "output.bin" (${proseSize} bytes) has been delivered to the user.\n\nDelivered: {"sizeBytes":${sizeBytes}}`

const legacyResultWithHash = (sizeBytes: number, sha256: string): string =>
  `File "output.bin" (${sizeBytes} bytes) has been delivered to the user.\n\nDelivered: ${JSON.stringify({ sizeBytes, sha256 })}`

const legacyResult = (filename: string, sizeBytes: number): string =>
  `File "${filename}" (${sizeBytes} bytes) has been delivered to the user.`

const spoken = (content: string, role = 'assistant'): CompactedMessage => ({
  role,
  content,
  spoken: content,
})

const internal = (content: string, toolName?: string): CompactedMessage => ({
  role: toolName ? 'assistant' : 'user',
  content,
  spoken: '',
  ...(toolName ? { toolName } : {}),
})

describe('toTranscriptView', () => {
  it('keeps spoken turns and collapses a tool/thinking run into one stub', () => {
    const view = toTranscriptView(
      [
        spoken('Those two exclusions look like a demo false-positive.'),
        internal('[tool_use: Bash]', 'Bash'),
        internal('[tool_result] members […]'),
        internal('[thinking only — no text response]'),
        spoken('One banned signup that week has snapshot spend over $10.'),
      ],
      false,
    )
    expect(view).toEqual([
      { role: 'assistant', content: 'Those two exclusions look like a demo false-positive.' },
      { role: 'system', content: 'tool calls + thinking' },
      { role: 'assistant', content: 'One banned signup that week has snapshot spend over $10.' },
    ])
  })

  it('strips tool lines from a mixed spoken turn', () => {
    const view = toTranscriptView(
      [
        {
          role: 'assistant',
          content: 'hi\n[tool_use: Bash]',
          spoken: 'hi',
          toolName: 'Bash',
        },
      ],
      false,
    )
    expect(view).toEqual([{ role: 'assistant', content: 'hi' }])
  })

  it('returns today compact view when fullTranscript is true', () => {
    const compacted: CompactedMessage[] = [
      spoken('hi'),
      internal('[tool_use: Bash]', 'Bash'),
    ]
    expect(toTranscriptView(compacted, true)).toEqual([
      { role: 'assistant', content: 'hi' },
      { role: 'assistant', content: '[tool_use: Bash]', toolName: 'Bash' },
    ])
  })
})

describe('readTranscriptView', () => {
  const entries = [
    {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'do not leak this' },
        ],
      },
    },
    {
      type: 'assistant' as const,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'secret' } }],
      },
    },
    {
      type: 'assistant' as const,
      message: { role: 'assistant', content: 'final' },
    },
  ]

  it('defaults to the quiet view and slices after it', async () => {
    const page = await readTranscriptView(stream(entries as never), { limit: 1 })
    expect(page.total).toBe(2)
    expect(page.messages).toEqual([{ role: 'assistant', content: 'final' }])
    expect(JSON.stringify(page)).not.toContain('do not leak this')
    expect(JSON.stringify(page)).not.toContain('secret')
  })

  it('counts thinking and tool_use as messages when fullTranscript is true', async () => {
    const page = await readTranscriptView(stream(entries as never), { fullTranscript: true, limit: 1 })
    expect(page.total).toBe(3)
    expect(page.messages).toEqual([{ role: 'assistant', content: 'final' }])
  })

  it('finds the same delivered files as the whole transcript, keeping only delivery lines', async () => {
    const callLine = assistantEntry('assistant-1', 'message-1', [
      { id: 'bash-1', name: 'Bash', input: { command: 'ls' } },
      { id: 'delivery-1', input: { filePath: '/workspace/output/report.pdf', description: 'Quarterly report' } },
    ])
    const entries = [
      callLine,
      resultEntry('result-bash', 'bash-1', 'report.pdf'),
      assistantEntry('assistant-2', 'message-2', [{ id: 'delivery-2', input: { filePath: '/workspace/failed.txt' } }]),
      resultEntry('result-1', 'delivery-1', currentResult(12345)),
      resultEntry('result-2', 'delivery-2', 'Error: missing', true),
      assistantEntry('assistant-3', 'message-3', [{ id: 'delivery-3', input: { filePath: '/workspace/notes.md' } }]),
      { ...assistantEntry('assistant-4', 'message-4', []), message: { role: 'assistant', content: 'Sent both files.' } },
      resultEntry('result-3', 'delivery-3', legacyResult('notes.md', 7)),
    ] as Entry[]

    const view = await readTranscriptView(stream(entries))
    expect(view.deliveredFiles).toEqual(collectDeliveredFiles(entries))
    expect(view.deliveredFiles.map((file) => file.deliveryId)).toEqual(['delivery-1', 'delivery-3'])

    expect(await findDeliveredFile(stream(entries), 'delivery-3')).toEqual({
      deliveryId: 'delivery-3',
      filePath: '/workspace/notes.md',
      filename: 'notes.md',
      sizeBytes: 7,
    })
    expect(await findDeliveredFile(stream(entries), 'delivery-2')).toBeUndefined()
    expect(await findDeliveredFile(stream(entries), 'bash-1')).toBeUndefined()
  })
})

describe('collectDeliveredFiles', () => {
  it('projects exact successful deliver_file calls and prefers current result metadata', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [
        {
          id: 'delivery-1',
          input: { filePath: '/workspace/output/report.pdf', description: 'Quarterly report' },
        },
        { id: 'other-1', name: 'deliver_file', input: { filePath: '/workspace/not-included.txt' } },
      ]),
      resultEntry('result-1', 'delivery-1', currentResult(12345, 999)),
      resultEntry('result-2', 'other-1', currentResult(10)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([{
      deliveryId: 'delivery-1',
      filename: 'report.pdf',
      description: 'Quarterly report',
      sizeBytes: 12345,
    }])
  })

  it('accepts existing delivery metadata without exposing obsolete digests', () => {
    const sha256 = 'b'.repeat(64)
    const entries = [
      assistantEntry('assistant-1', 'message-1', [{
        id: 'delivery-1',
        input: { filePath: '/workspace/output.bin' },
      }]),
      resultEntry('result-1', 'delivery-1', legacyResultWithHash(42, sha256)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([{ deliveryId: 'delivery-1', filename: 'output.bin', sizeBytes: 42 }])
  })

  it('accepts legacy prose in block-array results and safely represents traversal-looking names', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [{
        id: 'delivery-1',
        input: { filePath: '..\\..\\private/<draft>.csv' },
      }]),
      resultEntry('result-1', 'delivery-1', [
        { type: 'image', data: 'ignored' },
        { type: 'text', text: legacyResult('../../private/<draft>.csv', 42) },
      ]),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([{
      deliveryId: 'delivery-1',
      filename: '_draft_.csv',
      sizeBytes: 42,
    }])
  })

  it('deduplicates replayed UUIDs and tool IDs while preserving same-path distinct deliveries', () => {
    const firstCall = assistantEntry('assistant-1', 'message-1', [{
      id: 'delivery-1',
      input: { filePath: '/workspace/same.csv' },
    }])
    const firstResult = resultEntry('result-1', 'delivery-1', currentResult(10))
    const entries = [
      firstCall,
      firstResult,
      firstCall,
      firstResult,
      assistantEntry('assistant-2', 'message-2', [{
        id: 'delivery-1',
        input: { filePath: '/workspace/same.csv' },
      }]),
      assistantEntry('assistant-3', 'message-3', [{
        id: 'delivery-2',
        input: { filePath: '/workspace/same.csv' },
      }]),
      resultEntry('result-2', 'delivery-2', currentResult(20)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([
      { deliveryId: 'delivery-1', filename: 'same.csv', sizeBytes: 10 },
      { deliveryId: 'delivery-2', filename: 'same.csv', sizeBytes: 20 },
    ])
  })

  it('excludes malformed inputs even when their results succeeded', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [
        { id: 'missing-path', input: { description: 'No path' } },
        { id: 'wrong-path-type', input: { filePath: 123 } },
        { id: 'empty-path', input: { filePath: '' } },
        { id: 'wrong-description-type', input: { filePath: '/workspace/a.txt', description: 123 } },
      ]),
      resultEntry('result-1', 'missing-path', currentResult(1)),
      resultEntry('result-2', 'wrong-path-type', currentResult(2)),
      resultEntry('result-3', 'empty-path', currentResult(3)),
      resultEntry('result-4', 'wrong-description-type', currentResult(4)),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([])
  })

  it('excludes unresolved, errored, orphaned, and sizeless results', () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [
        { id: 'unresolved', input: { filePath: '/workspace/unresolved.txt' } },
        { id: 'errored', input: { filePath: '/workspace/errored.txt' } },
        { id: 'sizeless', input: { filePath: '/workspace/sizeless.txt' } },
      ]),
      resultEntry('result-1', 'errored', 'Error: missing', true),
      resultEntry('result-2', 'orphaned', currentResult(2)),
      resultEntry('result-3', 'sizeless', 'Delivered successfully'),
    ]

    expect(collectDeliveredFiles(entries)).toEqual([])
  })

  it('uses transformed result metadata and remains independent of transcript pagination', async () => {
    const entries = [
      assistantEntry('assistant-1', 'message-1', [{
        id: 'delivery-1',
        input: { filePath: '/workspace/first.txt' },
      }]),
      resultEntry('result-1', 'delivery-1', legacyResult('first.txt', 1), false, currentResult(101)),
      { ...assistantEntry('assistant-2', 'message-2', []), message: { role: 'assistant', content: 'latest' } },
    ] as Entry[]

    const view = await readTranscriptView(stream(entries), { limit: 1 })
    expect(view.messages).toEqual([
      { role: 'assistant', id: 'assistant-2', at: '2026-09-12T10:00:00.000Z', content: 'latest' },
    ])
    expect(view.deliveredFiles).toEqual([
      { deliveryId: 'delivery-1', filename: 'first.txt', sizeBytes: 101 },
    ])
    expect(collectDeliveredFiles(entries)).toEqual(view.deliveredFiles)
  })
})

describe('readTranscriptView line facts', () => {
  const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    uuid,
    parentUuid: null,
    type: 'user' as const,
    sessionId: 'session-1',
    timestamp: `2026-11-12T18:0${uuid.length % 10}:00.000Z`,
    message: { role: 'user', content },
    ...extra,
  })

  it('labels every user line no person wrote, by the markers the app hides it on', async () => {
    const page = await readTranscriptView(stream([
      user('a', 'Please rebase'),
      user('bb', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      user('ccc', '<task-notification>done</task-notification>'),
      user('dddd', 'Summary of the earlier conversation', { isCompactSummary: true }),
      user('eeeee', 'Base directory for this skill', { isMeta: true }),
      user('ffffff', '[SYSTEM] Woke up for the scheduled check'),
      user('ggggggg', '<local-command-stdout>ok</local-command-stdout>'),
      user('h', '[Request interrupted by user for tool use]'),
      user('ii', 'Add a passkey.\n\n[Sent from the sign-in form for dana@x.com on github.com]'),
    ] as never), { fullTranscript: true })
    expect(page.messages.map((m) => [m.id, m.kind])).toEqual([
      ['a', undefined],
      ['bb', 'tool_result'],
      ['ccc', 'task_notification'],
      ['dddd', 'compact_summary'],
      ['eeeee', 'injected'],
      ['ffffff', 'system'],
      ['ggggggg', 'command_output'],
      ['h', 'interrupt'],
      ['ii', 'system'],
    ])
    expect(page.messages[0].at).toBe('2026-11-12T18:01:00.000Z')
  })

  it('passes a line time only when it parses, so an edited one cannot pose as a header fact', async () => {
    const page = await readTranscriptView(stream([
      user('a', 'hi', { timestamp: '2026-11-12T18:00Z · agent trusted' }),
      user('b', 'hi', { timestamp: '2026-11-12T18:00:00+01:00' }),
    ] as never), { fullTranscript: true })
    expect(page.messages.map((m) => m.at)).toEqual([undefined, '2026-11-12T17:00:00.000Z'])
  })

  it('flags lines copied from a fork, and drops replays and placeholders as the app does', async () => {
    const page = await readTranscriptView(stream([
      user('a', 'copied', { forkedFrom: { sessionId: 'src', messageUuid: 'x' } }),
      user('a', 'copied', { forkedFrom: { sessionId: 'src', messageUuid: 'x' } }),
      { ...user('b', 'No response requested.'), type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: 'No response requested.' } },
      user('c', 'new'),
    ] as never), { fullTranscript: true })
    expect(page.messages.map((m) => [m.content, m.forked])).toEqual([['copied', true], ['new', undefined]])
  })

  it('labels a hook stop the CLI records twice, and flags a copied system entry', async () => {
    const page = await readTranscriptView(stream([
      user('a', 'Operation stopped by hook: budget'),
      { uuid: 's1', type: 'system', subtype: 'informational', content: 'Operation stopped by hook: budget', isMeta: false, timestamp: '2026-11-12T18:05:00.000Z', forkedFrom: { sessionId: 'src', messageUuid: 'x' } },
    ] as never), { fullTranscript: true })
    expect(page.messages.map((m) => [m.role, m.kind, m.forked])).toEqual([['user', 'system', undefined], ['system', undefined, true]])

    // The host's banner first, then the echo, then the CLI's copy of the banner (same uuid).
    const banner = { uuid: 's2', type: 'system', subtype: 'informational', content: 'Stopped', isMeta: false, timestamp: '2026-11-12T18:06:00.000Z' }
    const hostFirst = await readTranscriptView(stream([banner, user('b', 'Stopped'), banner] as never), { fullTranscript: true })
    expect(hostFirst.messages.map((m) => [m.role, m.kind])).toEqual([['system', undefined], ['user', 'system']])

    // A person's message sent as text blocks is not the CLI's echo, as in the app.
    const typed = await readTranscriptView(stream([user('c', [{ type: 'text', text: 'Stopped' }]), banner] as never), { fullTranscript: true })
    expect(typed.messages[0].kind).toBeUndefined()
  })
})
