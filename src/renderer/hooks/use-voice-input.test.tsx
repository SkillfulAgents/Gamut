// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { SttAdapter, SttSessionStats, TranscriptCallback, ErrorCallback } from '@renderer/lib/voice/contracts/stt'

const reporting = vi.hoisted(() => ({
  captureRendererException: vi.fn(),
  captureRendererMessage: vi.fn(),
  addRendererBreadcrumb: vi.fn(),
}))
vi.mock('@renderer/lib/error-reporting', () => reporting)

const stt = vi.hoisted(() => ({
  micGranted: true,
  isMicPermissionGranted: vi.fn(() => stt.micGranted),
  watchMicPermission: vi.fn(),
  acquireMicStream: vi.fn(),
  createSttAdapter: vi.fn(),
  startAudioCapture: vi.fn(),
}))
vi.mock('@renderer/lib/voice/registry/stt', () => stt)
vi.mock('@renderer/lib/voice/shared/audio-capture', () => stt)

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => api)

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

import { useIsVoiceConfigured, useVoiceConversationProblem, useVoiceInput } from './use-voice-input'

/** A speech adapter whose socket never opens unless the test says so. */
class FakeAdapter implements SttAdapter {
  readonly sampleRate = 24000
  readonly stats: SttSessionStats = {
    socketOpened: false,
    bytesReceived: 0,
    bytesSent: 0,
    bytesDropped: 0,
    peakSample: 0,
    serverEvents: {},
    interims: 0,
    finals: 0,
    errors: 0,
  }
  transcriptCb: TranscriptCallback | null = null
  errorCb: ErrorCallback | null = null
  connectResult: Promise<void> = new Promise(() => {})
  connect = vi.fn(() => this.connectResult)
  sendAudio = vi.fn()
  onTranscript(cb: TranscriptCallback) { this.transcriptCb = cb }
  onError(cb: ErrorCallback) { this.errorCb = cb }
  finish = vi.fn(async () => {})
  finalize = vi.fn()
  close = vi.fn()

  /** As if this many seconds of speech (or silence) had gone through. */
  heard(seconds: number, peakSample: number) {
    this.stats.bytesReceived = this.sampleRate * 2 * seconds
    this.stats.peakSample = peakSample
  }
}

const stream = {
  getAudioTracks: () => [{
    label: 'Built-in Microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
  }],
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream

const capture = () => ({
  stream,
  audioContext: { sampleRate: 24000 },
  analyser: {},
  captureKind: 'worklet',
  setSink: vi.fn(),
  cleanup: vi.fn(),
})

const TOKEN = { provider: 'openai', protocol: 'openai-realtime', token: 'ephemeral' }
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body })

/**
 * `status` is what the host's /configured answers. By default it names no
 * dictation protocol, as a host from before it did: the microphone then waits
 * for the token.
 */
function arrange(adapter: FakeAdapter, status: Record<string, unknown> = { configured: true, supportsTts: false, voices: [] }) {
  api.apiFetch.mockImplementation(async (url: string) => json(url === '/api/voice/configured' ? status : TOKEN))
  stt.acquireMicStream.mockResolvedValue(stream)
  stt.createSttAdapter.mockReturnValue(adapter)
  // As the real one: it is handed the microphone while that is still opening.
  stt.startAudioCapture.mockImplementation(async (_sink: unknown, mic: Promise<MediaStream>) => { await mic; return capture() })
  const onTranscriptUpdate = vi.fn()
  const onDictated = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // `statusIn` reads the same status query in the same render, so once it is
  // true the hook has the status too.
  const hook = renderHook(() => ({ ...useVoiceInput({ onTranscriptUpdate, onDictated }), statusIn: useIsVoiceConfigured() }), {
    wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
  return { hook, onTranscriptUpdate, onDictated }
}

/**
 * Kick off in one synchronous act so the 'connecting' render lands before the
 * credential round-trip resolves (as it does against a real network), then
 * let the rest of the start-up settle.
 */
async function start(hook: ReturnType<typeof arrange>['hook']) {
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.startRecording('') })
  await act(async () => { await pending })
}

async function startRecording(hook: ReturnType<typeof arrange>['hook']) {
  await start(hook)
  expect(hook.result.current.isRecording).toBe(true)
}

async function stop(hook: ReturnType<typeof arrange>['hook']) {
  await act(async () => { await hook.result.current.stopRecording() })
}

describe('useVoiceInput error reports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports a session that heard speech, never opened its socket, and produced no words', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    await stop(hook)

    expect(reporting.captureRendererMessage).toHaveBeenCalledTimes(1)
    const [message, context] = reporting.captureRendererMessage.mock.calls[0]
    expect(message).toBe('Dictation ended without a transcript (attempt 1)')
    expect(context.fingerprint).toEqual(['dictation', 'no-transcript'])
    expect(context.tags).toEqual({
      feature: 'dictation',
      stage: 'no_transcript',
      provider: 'openai',
      socket: 'never_opened',
      audio: 'audible',
      capture: 'worklet',
    })
    expect(context.extra).toMatchObject({
      provider: 'openai',
      captureKind: 'worklet',
      contextSampleRate: 24000,
      bytesReceived: 24000 * 2 * 4,
      peakSample: 9000,
      track: { label: 'Built-in Microphone', muted: false },
    })
    expect(reporting.captureRendererException).not.toHaveBeenCalled()
  })

  it('numbers retries so consecutive reports are not collapsed as duplicates, under one fingerprint', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    await stop(hook)
    const retry = new FakeAdapter()
    stt.createSttAdapter.mockReturnValue(retry)
    await startRecording(hook)
    retry.heard(4, 9000)
    await stop(hook)

    const messages = reporting.captureRendererMessage.mock.calls.map(([m]) => m)
    expect(messages).toEqual([
      'Dictation ended without a transcript (attempt 1)',
      'Dictation ended without a transcript (attempt 2)',
    ])
    const fingerprints = reporting.captureRendererMessage.mock.calls.map(([, c]) => c.fingerprint)
    expect(fingerprints[0]).toEqual(fingerprints[1])
    expect(reporting.captureRendererMessage.mock.calls[1][1].extra).toMatchObject({ attempt: 2 })
  })

  it('tells silence from the mic apart from speech the server ignored', async () => {
    const adapter = new FakeAdapter()
    adapter.stats.socketOpened = true
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 12)
    await stop(hook)

    expect(reporting.captureRendererMessage.mock.calls[0][1].tags).toMatchObject({ socket: 'opened', audio: 'silent' })
  })

  it('stays quiet about a tap too short to have been an attempt', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(0.5, 9000)
    await stop(hook)

    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('stays quiet when words came back', async () => {
    const adapter = new FakeAdapter()
    const { hook, onTranscriptUpdate } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    act(() => { adapter.transcriptCb?.({ type: 'final', text: 'hello there' }) })
    await stop(hook)

    expect(onTranscriptUpdate).toHaveBeenLastCalledWith('hello there')
    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('reports a stream error with the session, and not again as a missing transcript', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    await act(async () => { adapter.errorCb?.(new Error('OpenAI connection closed: 1008 policy violation')) })

    expect(hook.result.current.error).toBe('OpenAI connection closed: 1008 policy violation')
    expect(reporting.captureRendererException).toHaveBeenCalledTimes(1)
    const [err, context] = reporting.captureRendererException.mock.calls[0]
    expect((err as Error).message).toContain('1008')
    expect(context.tags).toEqual({ feature: 'dictation', stage: 'stream', provider: 'openai' })
    expect(context.extra).toMatchObject({ bytesReceived: 24000 * 2 * 4, captureKind: 'worklet' })
    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('reports a socket that failed to connect under its own stage', async () => {
    const adapter = new FakeAdapter()
    adapter.connectResult = Promise.reject(new Error('OpenAI Realtime WebSocket connection timed out'))
    adapter.connectResult.catch(() => {})
    const { hook } = arrange(adapter)
    await start(hook)

    expect(hook.result.current.error).toContain('timed out')
    expect(reporting.captureRendererException.mock.calls[0][1].tags).toEqual({ feature: 'dictation', stage: 'connect', provider: 'openai' })
    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('reports a failure to obtain credentials before any session exists', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    api.apiFetch.mockImplementation(async () => json({ error: 'No API key configured for OpenAI. Add one in Settings > Voice.' }, false))
    await start(hook)

    expect(hook.result.current.error).toContain('No API key configured')
    expect(reporting.captureRendererException.mock.calls[0][1].tags).toEqual({ feature: 'dictation', stage: 'credentials', provider: 'unknown' })
  })

  it('treats a refused microphone permission as a breadcrumb, not a defect', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    stt.acquireMicStream.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
    await start(hook)

    expect(hook.result.current.error).toBeTruthy()
    expect(hook.result.current.isRecording).toBe(false)
    expect(reporting.captureRendererException).not.toHaveBeenCalled()
    expect(reporting.addRendererBreadcrumb).toHaveBeenCalledWith('dictation', 'microphone permission refused', { stage: 'capture' })
  })
})

describe('useVoiceInput onDictated', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fires once a recording ends with words', async () => {
    const adapter = new FakeAdapter()
    const { hook, onTranscriptUpdate, onDictated } = arrange(adapter)
    await startRecording(hook)
    act(() => { adapter.transcriptCb?.({ type: 'interim', text: 'hello' }) })
    expect(onDictated).not.toHaveBeenCalled()
    await stop(hook)

    expect(onTranscriptUpdate).toHaveBeenLastCalledWith('hello')
    expect(onDictated).toHaveBeenCalledTimes(1)
  })

  it('does not fire for a recording that heard nothing', async () => {
    const adapter = new FakeAdapter()
    const { hook, onDictated } = arrange(adapter)
    await startRecording(hook)
    await stop(hook)

    expect(onDictated).not.toHaveBeenCalled()
  })
})

describe('useVoiceInput instant start', () => {
  const KNOWN = { configured: true, supportsTts: false, voices: [], sttProvider: 'openai', sttProtocol: 'openai-realtime' }

  /** A token round-trip the test finishes by hand. */
  function holdToken() {
    let release!: (response: unknown) => void
    const held = new Promise((resolve) => { release = resolve })
    api.apiFetch.mockImplementation((url: string) => (url === '/api/voice/configured' ? Promise.resolve(json(KNOWN)) : held))
    return { arrive: (response: unknown = json(TOKEN)) => act(async () => { release(response) }) }
  }

  /**
   * Waits for the status to reach the hook, not just for its request: the
   * query hands its result to the component on a timer (React Query's
   * notifyManager), which one act() does not always outlast on a loaded
   * machine. Until it lands, the hook does not know the protocol and the
   * microphone waits for the token.
   */
  async function arrangeKnown(adapter: FakeAdapter) {
    const arranged = arrange(adapter, KNOWN)
    await waitFor(() => expect(arranged.hook.result.current.statusIn).toBe(true))
    return arranged
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stt.micGranted = true
  })

  it('is recording, with the microphone capturing, before the token has come back', async () => {
    const adapter = new FakeAdapter()
    const { hook } = await arrangeKnown(adapter)
    const token = holdToken()

    let pending!: Promise<void>
    act(() => { pending = hook.result.current.startRecording('') })
    // Synchronously, on the click: listening, nothing awaited.
    expect(hook.result.current.isRecording).toBe(true)
    expect(stt.createSttAdapter).toHaveBeenCalledWith('openai-realtime', 'openai')
    expect(stt.startAudioCapture).toHaveBeenCalledTimes(1)
    expect(stt.startAudioCapture.mock.calls[0][0]).toBe(adapter)
    expect(adapter.connect).not.toHaveBeenCalled()

    await token.arrive()
    await act(async () => { await pending })
    expect(adapter.connect).toHaveBeenCalledWith('ephemeral')
    expect(hook.result.current.isRecording).toBe(true)
  })

  it('shows connecting, not recording, while a permission prompt may be up', async () => {
    stt.micGranted = false
    const { hook } = await arrangeKnown(new FakeAdapter())
    holdToken()
    let release!: (handle: unknown) => void
    stt.startAudioCapture.mockReturnValue(new Promise((resolve) => { release = resolve }))

    act(() => { void hook.result.current.startRecording('') })
    expect(hook.result.current.isConnecting).toBe(true)
    await act(async () => { release(capture()) })
    expect(hook.result.current.isRecording).toBe(true)
  })

  it('keeps words spoken before the token arrived when stopped that early', async () => {
    const adapter = new FakeAdapter()
    const { hook, onTranscriptUpdate } = await arrangeKnown(adapter)
    const token = holdToken()
    act(() => { void hook.result.current.startRecording('') })
    await act(async () => {})
    adapter.heard(1, 9000)
    adapter.finish.mockImplementation(async () => { adapter.transcriptCb?.({ type: 'final', text: 'quick note' }) })

    let stopped!: Promise<string | undefined>
    act(() => { stopped = hook.result.current.stopRecording() })
    await act(async () => {})
    // Waiting for a socket to flush through: finishing now would drop the audio.
    expect(adapter.finish).not.toHaveBeenCalled()

    await token.arrive()
    await act(async () => { await stopped })
    expect(adapter.connect).toHaveBeenCalledWith('ephemeral')
    expect(adapter.connect.mock.invocationCallOrder[0]).toBeLessThan(adapter.finish.mock.invocationCallOrder[0])
    expect(onTranscriptUpdate).toHaveBeenLastCalledWith('quick note')
    expect(hook.result.current.state).toBe('idle')
  })

  it('opens no socket for a dictation stopped before it heard anything', async () => {
    const adapter = new FakeAdapter()
    const { hook } = await arrangeKnown(adapter)
    const token = holdToken()
    act(() => { void hook.result.current.startRecording('kept') })
    await act(async () => {})
    await act(async () => { await hook.result.current.stopRecording() })
    expect(adapter.close).toHaveBeenCalled()
    await token.arrive()

    expect(adapter.connect).not.toHaveBeenCalled()
    expect(hook.result.current.state).toBe('idle')
  })

  it('leaves the field alone when the token fails after the dictation was already stopped', async () => {
    const { hook, onTranscriptUpdate } = await arrangeKnown(new FakeAdapter())
    const token = holdToken()
    act(() => { void hook.result.current.startRecording('kept') })
    await act(async () => {})
    await act(async () => { await hook.result.current.stopRecording() })
    const updates = onTranscriptUpdate.mock.calls.length
    await token.arrive(json({ error: 'Voice quota exceeded' }, false))

    // Whatever has been typed since the stop is not replaced by the old text.
    expect(onTranscriptUpdate).toHaveBeenCalledTimes(updates)
    expect(hook.result.current.error).toBeNull()
  })

  it('starts over at the right rate when the token names another protocol than the status did', async () => {
    const first = new FakeAdapter()
    const { hook } = await arrangeKnown(first)
    const token = holdToken()
    const firstCapture = capture()
    stt.startAudioCapture.mockResolvedValueOnce(firstCapture)
    act(() => { void hook.result.current.startRecording('') })
    await act(async () => {})

    const second = new FakeAdapter()
    stt.createSttAdapter.mockReturnValue(second)
    await token.arrive(json({ provider: 'deepgram', protocol: 'deepgram', token: 'dg' }))

    expect(first.close).toHaveBeenCalled()
    expect(first.connect).not.toHaveBeenCalled()
    expect(firstCapture.cleanup).toHaveBeenCalled()
    expect(stt.createSttAdapter).toHaveBeenLastCalledWith('deepgram', 'deepgram')
    expect(stt.startAudioCapture.mock.calls[1][0]).toBe(second)
    expect(second.connect).toHaveBeenCalledWith('dg')
    expect(hook.result.current.isRecording).toBe(true)
  })

  it('ends with the text it started from when the token is refused mid-capture', async () => {
    const adapter = new FakeAdapter()
    const { hook, onTranscriptUpdate } = await arrangeKnown(adapter)
    const token = holdToken()
    const running = capture()
    stt.startAudioCapture.mockResolvedValueOnce(running)
    act(() => { void hook.result.current.startRecording('draft') })
    await act(async () => {})
    await token.arrive(json({ error: 'Voice quota exceeded' }, false))

    expect(hook.result.current.error).toBe('Voice quota exceeded')
    expect(hook.result.current.state).toBe('idle')
    expect(running.cleanup).toHaveBeenCalled()
    expect(adapter.close).toHaveBeenCalled()
    expect(onTranscriptUpdate).toHaveBeenLastCalledWith('draft')
    expect(reporting.captureRendererException.mock.calls[0][1].tags).toMatchObject({ stage: 'credentials', provider: 'openai' })
  })
})

describe('useVoiceConversationProblem', () => {
  function renderProblem(response: { ok: boolean; status: number; body?: unknown }) {
    api.apiFetch.mockResolvedValue({ ok: response.ok, status: response.status, json: async () => response.body })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return renderHook(() => useVoiceConversationProblem(), {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    })
  }

  it('says nothing once an engine is available', async () => {
    const hook = renderProblem({ ok: true, status: 200, body: { configured: true, supportsTts: true, voices: [], conversationEngine: 'openai-live' } })
    expect(hook.result.current).toBeNull()
    await waitFor(() => expect(api.apiFetch).toHaveBeenCalledWith('/api/voice/configured'))
    expect(hook.result.current).toBeNull()
  })

  it('names a host without voice', async () => {
    const hook = renderProblem({ ok: true, status: 200, body: { configured: false, supportsTts: false, voices: [] } })
    await waitFor(() => expect(hook.result.current).toBe('Voice is not set up on this host (Settings → Voice).'))
  })

  it('names a status request the host refused, rather than calling voice unconfigured', async () => {
    const hook = renderProblem({ ok: false, status: 401, body: { error: 'Unauthorized' } })
    await waitFor(() => expect(hook.result.current).toBe('Voice settings could not be loaded (401).'))
  })
})
