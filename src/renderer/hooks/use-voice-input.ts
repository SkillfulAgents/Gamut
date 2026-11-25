import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { acquireMicStream, isMicPermissionGranted, startAudioCapture, watchMicPermission, type AudioCaptureHandle, type CaptureKind } from '@renderer/lib/voice/shared/audio-capture'
import { createSttAdapter } from '@renderer/lib/voice/registry/stt'
import { type SttAdapter, type VoiceProvider } from '@renderer/lib/voice/contracts/stt'
import { resolveSttProtocol, type SttProtocol, type VoiceTokenResponse } from '@shared/lib/voice/stt-protocol'
import { addRendererBreadcrumb, captureRendererException, captureRendererMessage } from '@renderer/lib/error-reporting'
import type { VoiceConversationEngine } from '@shared/lib/voice/conversation-types'
import type { TtsVoiceInfo } from '@shared/lib/voice/tts-preferences'

// 'connecting': the microphone is opening behind a permission prompt, or the
// host is too old to say which speech protocol to open it for. Otherwise a
// dictation is 'recording' from the click.
// 'finalizing': mic released, but we're flushing buffered audio and awaiting the
// server's trailing transcripts before the final text is ready.
export type VoiceInputState = 'idle' | 'connecting' | 'recording' | 'finalizing'

/**
 * One dictation attempt, from credentials to final text, as the error reports
 * describe it. Dictation audio goes from the browser straight to the speech
 * provider, so nothing server-side sees a session that fails on that leg; the
 * renderer has to report it.
 */
interface DictationSession {
  provider: VoiceProvider
  protocol: SttProtocol
  /**
   * Settles once the adapter has been told to connect (or never will be).
   * Capture starts before the token is in, so a stop that comes first waits
   * for this: finishing an adapter that has no socket yet drops what it heard.
   */
  connectRequested: Promise<void>
  markConnectRequested: () => void
  connectWasRequested: boolean
  /** Stopped before anything was heard: there is nothing to connect for. */
  discarded: boolean
  /** Ordinal of this attempt within the page, so retries can be told apart. */
  attempt: number
  startedAt: number
  adapter: SttAdapter
  captureKind?: CaptureKind
  contextSampleRate?: number
  track?: Record<string, unknown>
  /** An error has already been shown and reported for this session. */
  failed: boolean
}

/**
 * Audio a session must have captured before ending with no words counts as a
 * failure worth reporting, rather than a mic tap the person changed their mind
 * about. In seconds of PCM at the adapter's rate.
 */
const NO_TRANSCRIPT_REPORT_MIN_SECONDS = 1.5

/**
 * A peak sample at or below this (about -36 dBFS) means the mic delivered
 * silence: the person did not speak, or the OS handed us a muted device.
 */
const SILENT_PEAK_SAMPLE = 500

/** How long a stop waits for the token of a dictation that has already heard something. */
const STOP_WAITS_FOR_TOKEN_MS = 4_000

/** What a dictation connects with: enough to open the microphone at the right rate. */
interface SttTarget {
  provider: VoiceProvider
  protocol: SttProtocol
}

/** Denied or missing mic permission is the person's choice, not a defect. */
function isMicPermissionRefusal(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError' || err.name === 'SecurityError')
}

function describeTrack(stream: MediaStream): Record<string, unknown> {
  const track = stream.getAudioTracks()[0]
  if (!track) return { present: false }
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  return {
    present: true,
    label: track.label,
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
    sampleRate: settings.sampleRate,
    channelCount: settings.channelCount,
  }
}

function describeSession(session: DictationSession): Record<string, unknown> {
  return {
    provider: session.provider,
    attempt: session.attempt,
    durationMs: Date.now() - session.startedAt,
    captureKind: session.captureKind,
    contextSampleRate: session.contextSampleRate,
    adapterSampleRate: session.adapter.sampleRate ?? 16000,
    track: session.track,
    ...session.adapter.stats,
  }
}

function reportSessionFailure(session: DictationSession | null, provider: VoiceProvider | undefined, stage: string, err: unknown): void {
  if (session) session.failed = true
  if (isMicPermissionRefusal(err)) {
    addRendererBreadcrumb('dictation', 'microphone permission refused', { stage })
    return
  }
  captureRendererException(err, {
    tags: { feature: 'dictation', stage, provider: session?.provider ?? provider ?? 'unknown' },
    extra: session ? describeSession(session) : undefined,
  })
}

/**
 * The session ended with audio captured but no words back, and no error was
 * shown: the case that otherwise leaves no trace anywhere. Tagged so a socket
 * that never opened, silence from the mic, and a server that stayed quiet can
 * each be told apart in the tracker.
 */
function reportNoTranscript(session: DictationSession): void {
  const stats = session.adapter.stats
  if (!stats) return
  const minBytes = (session.adapter.sampleRate ?? 16000) * 2 * NO_TRANSCRIPT_REPORT_MIN_SECONDS
  if (stats.bytesReceived < minBytes) return
  // The attempt number is in the message on purpose: Sentry drops an event
  // identical to the previous one, and a person who retries three times in a
  // row is exactly who we need every attempt from. The fingerprint keeps them
  // in one issue.
  captureRendererMessage(`Dictation ended without a transcript (attempt ${session.attempt})`, {
    fingerprint: ['dictation', 'no-transcript'],
    level: 'warning',
    tags: {
      feature: 'dictation',
      stage: 'no_transcript',
      provider: session.provider,
      socket: stats.socketOpened ? 'opened' : 'never_opened',
      audio: stats.peakSample > SILENT_PEAK_SAMPLE ? 'audible' : 'silent',
      capture: session.captureKind ?? 'unknown',
    },
    extra: describeSession(session),
  })
}

interface UseVoiceInputOptions {
  onTranscriptUpdate: (text: string) => void
  /** Fires when a recording ends having transcribed some words, after its final text is applied. */
  onDictated?: () => void
}

type SttCredentials = VoiceTokenResponse

interface VoiceConfiguredStatus {
  /** The dictation provider and its wire protocol. Absent on an older host. */
  sttProvider?: VoiceProvider
  sttProtocol?: SttProtocol
  conversationEngine?: VoiceConversationEngine | null
  configured: boolean
  supportsTts: boolean
  /** Read-aloud voices the configured provider offers; empty when it cannot speak. */
  voices: TtsVoiceInfo[]
  /** The deployment's default among them (for anyone without their own pick). */
  defaultVoice?: string
  /** Voices a Live conversation (a meeting bot) can speak with; empty when the provider has no Live engine. */
  liveVoices?: TtsVoiceInfo[]
  liveDefaultVoice?: string
}

const NOT_CONFIGURED: VoiceConfiguredStatus = { configured: false, supportsTts: false, voices: [] }
const NO_VOICES: TtsVoiceInfo[] = []

function useVoiceConfiguredQuery() {
  return useQuery<VoiceConfiguredStatus>({
    queryKey: ['voice-configured'],
    queryFn: async () => {
      const res = await apiFetch('/api/voice/configured')
      if (!res.ok) throw new Error(`Voice settings could not be loaded (${res.status}).`)
      return res.json() as Promise<VoiceConfiguredStatus>
    },
    staleTime: 60_000,
  })
}

/** Until the status is in, or when it cannot be loaded, voice counts as not configured. */
function useVoiceConfiguredStatus(): VoiceConfiguredStatus {
  return useVoiceConfiguredQuery().data ?? NOT_CONFIGURED
}

function conversationEngineOf(status: VoiceConfiguredStatus): VoiceConversationEngine | null {
  return status.conversationEngine ?? (status.configured && status.supportsTts ? 'chained' : null)
}

/** Hook to check whether voice input is fully configured (provider + API key). */
export function useIsVoiceConfigured(): boolean {
  return useVoiceConfiguredStatus().configured
}

/**
 * Hook to check whether the configured voice provider can read text aloud.
 * Returns false if voice is not configured at all.
 */
export function useIsTtsConfigured(): boolean {
  return useVoiceConfiguredStatus().supportsTts
}

/**
 * The read-aloud voices the configured provider offers, and the deployment's
 * default among them. Served to every user (the settings endpoint itself is
 * admin-only in auth mode).
 */
export function useTtsVoices(): { voices: TtsVoiceInfo[]; defaultVoice: string | undefined } {
  const { voices, defaultVoice } = useVoiceConfiguredStatus()
  return { voices, defaultVoice }
}

/** The voices a Live conversation can speak with, as the configured provider offers them; empty without a Live engine. */
export function useLiveVoices(): { voices: TtsVoiceInfo[]; defaultVoice: string | undefined } {
  const { liveVoices, liveDefaultVoice } = useVoiceConfiguredStatus()
  return { voices: liveVoices ?? NO_VOICES, defaultVoice: liveDefaultVoice }
}

/**
 * Whether voice mode (talk, and hear the replies) can be offered here: the
 * configured provider supports a chained or Live conversation, and this
 * browser has a microphone API.
 */
export function useCanUseVoiceMode(): boolean {
  const { configured, supportsTts, conversationEngine } = useVoiceConfiguredStatus()
  const hasMic = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  return configured && (supportsTts || !!conversationEngine) && hasMic
}

/** The transport for in-session voice, separate from dictation and read-aloud. */
export function useVoiceConversationEngine(): VoiceConversationEngine | null {
  return conversationEngineOf(useVoiceConfiguredStatus())
}

/**
 * Why a voice conversation cannot start here, for a surface that runs voice
 * mode without offering it first (the meeting bot's page): null while the
 * status loads and once an engine is available.
 */
export function useVoiceConversationProblem(): string | null {
  const { data, error } = useVoiceConfiguredQuery()
  if (data) return conversationEngineOf(data) ? null : 'Voice is not set up on this host (Settings → Voice).'
  return error?.message ?? null
}

export function useVoiceInput({ onTranscriptUpdate, onDictated }: UseVoiceInputOptions) {
  const [state, setState] = useState<VoiceInputState>('idle')
  const [error, setError] = useState<string | null>(null)
  const { track } = useAnalyticsTracking()

  const adapterRef = useRef<SttAdapter | null>(null)
  const captureRef = useRef<AudioCaptureHandle | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const stateRef = useRef<VoiceInputState>('idle')
  // True for the duration of a stopRecording() call so a second trigger
  // (submit + button, or an error callback) can't start a second finish.
  const stoppingRef = useRef(false)
  // Per-attempt token. Bumped by each startRecording and on unmount, so an
  // in-flight startRecording whose awaits resolve after a stop/restart or after
  // the component unmounts can detect it's stale and release what it acquired
  // instead of resurrecting a session nobody owns.
  const generationRef = useRef(0)
  // The attempt in progress, as the error reports describe it.
  const sessionRef = useRef<DictationSession | null>(null)
  // Attempts started on this page, numbering each report.
  const attemptsRef = useRef(0)

  // Keep stateRef in sync so callbacks always see the latest value
  stateRef.current = state

  // Track text accumulation across interim/final events
  const prefixRef = useRef('')
  const finalizedRef = useRef('')
  const interimRef = useRef('')

  const isSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

  // What the host says a dictation connects with, read ahead of the click so
  // the click itself waits for nothing.
  const { sttProvider, sttProtocol } = useVoiceConfiguredStatus()
  const targetRef = useRef<SttTarget | null>(null)
  targetRef.current = sttProvider && sttProtocol ? { provider: sttProvider, protocol: sttProtocol } : null
  useEffect(() => { watchMicPermission() }, [])

  const cleanup = useCallback(() => {
    // Tearing down invalidates the current attempt, so an in-flight startRecording
    // whose awaits resolve afterward sees a stale generation and bails.
    generationRef.current++
    captureRef.current?.cleanup()
    captureRef.current = null
    analyserRef.current = null

    adapterRef.current?.close()
    adapterRef.current = null
    sessionRef.current?.markConnectRequested()
    sessionRef.current = null
  }, [])

  /**
   * Stop recording and resolve with the final text. Releases the mic immediately,
   * then keeps the adapter alive long enough to flush any audio buffered during
   * the handshake and collect the server's trailing transcripts (bounded by the
   * adapter's own finish() timeout) so the tail of the utterance isn't lost.
   */
  const stopRecording = useCallback(async (): Promise<string | undefined> => {
    const st = stateRef.current
    if (stoppingRef.current || (st !== 'recording' && st !== 'connecting')) return undefined
    stoppingRef.current = true
    stateRef.current = 'finalizing'
    setState('finalizing')

    // Release the mic right away; keep the adapter to flush + await finals.
    captureRef.current?.cleanup()
    captureRef.current = null
    analyserRef.current = null

    // Detach the adapter before awaiting so late error/connect callbacks (which
    // guard on adapter identity) treat this session as already gone.
    const adapter = adapterRef.current
    adapterRef.current = null
    const session = sessionRef.current
    sessionRef.current = null
    if (adapter && session && !session.connectWasRequested) {
      if ((adapter.stats?.bytesReceived ?? 0) === 0) {
        // Stopped before a sample arrived: nothing to transcribe, nothing to wait for.
        session.discarded = true
        adapter.close()
      } else {
        // Words were spoken before the token came back. They are buffered in
        // the adapter; give it its socket before asking it to finish.
        await Promise.race([
          session.connectRequested,
          new Promise<void>((resolve) => setTimeout(resolve, STOP_WAITS_FOR_TOKEN_MS)),
        ])
      }
    }
    await adapter?.finish().catch(() => {}) // finish() never rejects; guard anyway

    // Include both finalized and any pending interim text
    const prefix = prefixRef.current
    const finalized = finalizedRef.current
    const interim = interimRef.current
    prefixRef.current = ''
    finalizedRef.current = ''
    interimRef.current = ''
    const transcribed = (finalized + (interim ? (finalized ? ' ' : '') + interim : '')).trimEnd()
    if (session) {
      addRendererBreadcrumb('dictation', 'stopped', { transcribedChars: transcribed.length, ...describeSession(session) })
      if (!transcribed && !session.failed) reportNoTranscript(session)
    }
    // If nothing was transcribed, restore original text (prefix without trailing space)
    const finalText = transcribed
      ? prefix + transcribed
      : prefix.trimEnd()
    onTranscriptUpdate(finalText)
    if (transcribed) {
      track('dictation_used', { length: transcribed.length })
      onDictated?.()
    }
    // The attempt is over. A start whose token is still on its way (or fails
    // late) finds itself stale, and neither connects nor puts back the text the
    // attempt began with over whatever has been typed since.
    generationRef.current++
    stateRef.current = 'idle'
    setState('idle')
    stoppingRef.current = false
    return finalText
  }, [onTranscriptUpdate, onDictated, track])

  const startRecording = useCallback(async (existingText: string) => {
    if (stateRef.current !== 'idle') return
    setError(null)

    // Claim this attempt. If the generation moves on (restart or unmount) while
    // we're awaiting below, isStale() is true and we bail without resurrecting.
    const generation = ++generationRef.current
    const isStale = () => generation !== generationRef.current

    // Save prefix (text already in textarea before recording)
    prefixRef.current = existingText ? existingText + ' ' : ''
    finalizedRef.current = ''
    interimRef.current = ''

    // Listening from this moment whenever nothing stands between the click and
    // the microphone: the protocol is known, and opening it will not ask.
    const known = targetRef.current
    const initial: VoiceInputState = known && isMicPermissionGranted() ? 'recording' : 'connecting'
    stateRef.current = initial
    setState(initial)

    // Open the mic now, alongside the token round-trip rather than after it.
    // Rejections are observed here so a fast failure (denied permission, no
    // device) cannot surface as an unhandledrejection before it is awaited.
    let streamPromise = acquireMicStream()
    streamPromise.catch(() => {})
    const releaseStream = () => {
      streamPromise.then((stream) => {
        if (captureRef.current?.stream !== stream) stream.getTracks().forEach((t) => t.stop())
      }).catch(() => {})
    }

    let provider: VoiceProvider | undefined = known?.provider
    let session: DictationSession | null = null
    let stage: 'credentials' | 'capture' = 'credentials'
    let failed = false

    const fail = (err: unknown) => {
      releaseStream()
      if (failed || isStale()) return
      failed = true
      const message = err instanceof Error ? err.message : 'Failed to start recording'
      console.error('Voice input error:', err)
      reportSessionFailure(session, provider, stage, err)
      setError(message)
      // A stop already under way owns the text and the state; it is waiting on
      // this session's adapter, which closing releases.
      const stopping = stoppingRef.current
      session?.adapter.close()
      session?.markConnectRequested()
      cleanup()
      if (stopping) return
      // Restore original text that was in the textarea before recording started
      onTranscriptUpdate(existingText)
      prefixRef.current = ''
      finalizedRef.current = ''
      interimRef.current = ''
      stateRef.current = 'idle'
      setState('idle')
    }

    /** Create the adapter and wire its events. It buffers audio until it is connected. */
    const openSession = (target: SttTarget): DictationSession => {
      const adapter = createSttAdapter(target.protocol, target.provider)
      let markConnectRequested!: () => void
      const connectRequested = new Promise<void>((resolve) => { markConnectRequested = resolve })
      const opened: DictationSession = {
        provider: target.provider,
        protocol: target.protocol,
        attempt: ++attemptsRef.current,
        startedAt: Date.now(),
        adapter,
        failed: false,
        connectRequested,
        markConnectRequested,
        connectWasRequested: false,
        discarded: false,
      }
      adapterRef.current = adapter
      sessionRef.current = opened

      adapter.onTranscript((event) => {
        switch (event.type) {
          case 'interim':
            interimRef.current = event.text
            onTranscriptUpdate(prefixRef.current + finalizedRef.current + interimRef.current)
            break
          case 'final':
            finalizedRef.current += (finalizedRef.current ? ' ' : '') + event.text
            interimRef.current = ''
            onTranscriptUpdate(prefixRef.current + finalizedRef.current)
            break
          case 'speech_ended':
            break
        }
      })

      adapter.onError((err) => {
        if (adapterRef.current !== adapter) return // stale/orphaned adapter — don't touch the live session
        console.error('STT adapter error:', err)
        reportSessionFailure(opened, target.provider, 'stream', err)
        setError(err.message)
        stopRecording()
      })
      return opened
    }

    /**
     * Mic capture into the session's adapter. The audio graph is built while
     * the microphone opens; whatever is heard before the socket is up waits in
     * the adapter's own buffer.
     */
    const startCapture = async (target: DictationSession): Promise<void> => {
      const capture = await startAudioCapture(target.adapter, streamPromise, { withAnalyser: true })
      // Stale (restart/unmount), stopped or replaced: whoever moved on has dealt
      // with the adapter; the capture is ours to release.
      if (isStale() || adapterRef.current !== target.adapter) {
        capture.cleanup()
        return
      }
      captureRef.current = capture
      analyserRef.current = capture.analyser
      target.captureKind = capture.captureKind
      target.contextSampleRate = capture.audioContext.sampleRate
      target.track = describeTrack(capture.stream)
      addRendererBreadcrumb('dictation', 'capture started', {
        provider: target.provider,
        captureKind: target.captureKind,
        contextSampleRate: target.contextSampleRate,
        track: target.track,
        startMs: Date.now() - target.startedAt,
      })
      stateRef.current = 'recording'
      setState('recording')
    }

    try {
      // 1. With the protocol known, capture starts now and the token catches up.
      let capturing: Promise<void> | null = null
      if (known) {
        session = openSession(known)
        capturing = startCapture(session)
        // A refused mic should not wait for the token to say so.
        capturing.catch((err: unknown) => { stage = 'capture'; fail(err) })
      }

      // 2. Get a token from the backend
      const credRes = await apiFetch('/api/voice/token')
      const credData: SttCredentials | { error: string } = await credRes.json()
      if (!credRes.ok) {
        throw new Error(('error' in credData ? credData.error : null) || 'Failed to get STT credentials')
      }
      const credentials = credData as SttCredentials
      provider = credentials.provider
      const target: SttTarget = { provider, protocol: resolveSttProtocol(credentials) }
      addRendererBreadcrumb('dictation', 'credentials received', { provider })
      stage = 'capture'

      // Bail if a restart, a failure or an unmount happened while fetching the token.
      if (isStale()) {
        releaseStream()
        return
      }

      if (session && (session.provider !== target.provider || session.protocol !== target.protocol)) {
        // The voice settings changed after the status was read: what has been
        // captured is at the wrong rate for this token. Start over with it.
        const stopped = adapterRef.current !== session.adapter
        session.adapter.close()
        session.markConnectRequested()
        if (stopped) return
        captureRef.current?.cleanup()
        captureRef.current = null
        analyserRef.current = null
        adapterRef.current = null
        sessionRef.current = null
        session = null
        streamPromise = acquireMicStream()
        streamPromise.catch(() => {})
      }

      if (!session) {
        // Stopped while there was nothing but the token to wait for.
        // Cast needed because TS narrows the ref, but callbacks can mutate it during awaits.
        if ((stateRef.current as VoiceInputState) !== 'connecting' && (stateRef.current as VoiceInputState) !== 'recording') {
          releaseStream()
          return
        }
        session = openSession(target)
        capturing = startCapture(session)
      }

      // 3. Connect in the background — the adapter buffers audio sent before
      // the socket opens, so recording does not wait for the handshake.
      if (!session.discarded) {
        const connecting = session
        connecting.connectWasRequested = true
        connecting.adapter.connect(credentials.token).catch((err: unknown) => {
          if (adapterRef.current !== connecting.adapter) return // recording already stopped
          const message = err instanceof Error ? err.message : 'Failed to connect'
          console.error('STT connect error:', err)
          reportSessionFailure(connecting, provider, 'connect', err)
          setError(message)
          stopRecording()
        })
      }
      session.markConnectRequested()

      await capturing
    } catch (err) {
      fail(err)
    }
  }, [cleanup, onTranscriptUpdate, stopRecording])

  // Cleanup on unmount (also bumps the generation, invalidating any in-flight start)
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  const clearError = useCallback(() => setError(null), [])

  return {
    state,
    isRecording: state === 'recording',
    isConnecting: state === 'connecting',
    isFinalizing: state === 'finalizing',
    error,
    clearError,
    isSupported,
    analyserRef,
    startRecording,
    stopRecording,
  }
}
