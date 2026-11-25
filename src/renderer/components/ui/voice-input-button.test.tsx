// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { VoiceInputButton } from './voice-input-button'

vi.mock('@renderer/context/dialog-context', () => ({
  useDialogs: () => ({ openSettings: vi.fn() }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, isAdmin: true }),
}))

vi.mock('@renderer/hooks/use-voice-input', () => ({
  useIsVoiceConfigured: () => true,
}))

vi.mock('@renderer/components/ui/mini-waveform', () => ({
  MiniWaveform: ({ color }: { color: string }) => <div data-testid="mini-waveform" data-color={color} />,
}))

describe('VoiceInputButton', () => {
  it('uses theme-aware active styling and keeps the stop control visible', () => {
    render(
      <VoiceInputButton
        message=""
        voiceInput={{
          state: 'recording',
          isRecording: true,
          isConnecting: false,
          isFinalizing: false,
          error: null,
          clearError: vi.fn(),
          isSupported: true,
          analyserRef: { current: null },
          startRecording: vi.fn(),
          stopRecording: vi.fn(),
        }}
      />,
    )

    const button = screen.getByTestId('voice-input-button')
    expect(button).toHaveAccessibleName('Stop recording')
    expect(button).toHaveClass('bg-primary/10', 'text-foreground', 'dark:bg-primary/15')
    expect(button).not.toHaveClass('bg-background', 'hover:bg-zinc-100')
    expect(screen.getByTestId('mini-waveform')).toHaveAttribute('data-color', 'currentColor')
  })

  it('keeps the recording tint on Liquid Glass and only rounds it into a capsule', () => {
    render(
      <VoiceInputButton
        message=""
        glass
        voiceInput={{
          state: 'recording',
          isRecording: true,
          isConnecting: false,
          isFinalizing: false,
          error: null,
          clearError: vi.fn(),
          isSupported: true,
          analyserRef: { current: null },
          startRecording: vi.fn(),
          stopRecording: vi.fn(),
        }}
      />,
    )

    const button = screen.getByTestId('voice-input-button')
    expect(button).toHaveClass('rounded-full', 'bg-primary/10', 'border-primary/30')
    expect(button).not.toHaveClass('bg-white/40', 'border-transparent')
  })

  it('gives the idle mic a translucent fill with a hover on Liquid Glass', () => {
    render(
      <VoiceInputButton
        message=""
        glass
        voiceInput={{
          state: 'idle',
          isRecording: false,
          isConnecting: false,
          isFinalizing: false,
          error: null,
          clearError: vi.fn(),
          isSupported: true,
          analyserRef: { current: null },
          startRecording: vi.fn(),
          stopRecording: vi.fn(),
        }}
      />,
    )

    const button = screen.getByTestId('voice-input-button')
    expect(button).toHaveClass('rounded-full', 'bg-white/40', 'hover:bg-white/60')
    expect(button).not.toHaveClass('bg-background', 'rounded-md')
  })

  it('does not mount the waveform while idle', () => {
    render(
      <VoiceInputButton
        message=""
        voiceInput={{
          state: 'idle',
          isRecording: false,
          isConnecting: false,
          isFinalizing: false,
          error: null,
          clearError: vi.fn(),
          isSupported: true,
          analyserRef: { current: null },
          startRecording: vi.fn(),
          stopRecording: vi.fn(),
        }}
      />,
    )

    expect(screen.getByTestId('voice-input-button')).toHaveAccessibleName('Voice input')
    expect(screen.queryByTestId('mini-waveform')).not.toBeInTheDocument()
  })

  describe('keys', () => {
    type Voice = Parameters<typeof VoiceInputButton>[0]['voiceInput']
    const voice = (state: Voice['state'], overrides: Partial<Voice> = {}): Voice => ({
      state,
      isRecording: state === 'recording',
      isConnecting: state === 'connecting',
      isFinalizing: state === 'finalizing',
      error: null,
      clearError: vi.fn(),
      isSupported: true,
      analyserRef: { current: null },
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      ...overrides,
    })
    const composer = (voiceInput: Voice, onSend?: () => void) => (
      <form>
        <textarea data-testid="field" defaultValue="hello" />
        <VoiceInputButton message="hello" voiceInput={voiceInput} onSend={onSend} />
      </form>
    )
    const onScreen = () => {
      // jsdom lays nothing out; the shortcut only goes to a mic that is on screen.
      screen.getByTestId('voice-input-button').getClientRects = () => [{}] as unknown as DOMRectList
    }

    it('starts dictating on Control+M with the text already in the field', () => {
      const idle = voice('idle')
      render(composer(idle))
      onScreen()
      fireEvent.keyDown(document.body, { key: 'm', code: 'KeyM', ctrlKey: true })
      expect(idle.startRecording).toHaveBeenCalledWith('hello')
      expect(screen.getByTestId('voice-input-button')).toHaveAttribute('title', expect.stringMatching(/^Dictate \((⌃M|Ctrl\+M)\)$/))
    })

    it('stops on the same shortcut, keeping the text', () => {
      const recording = voice('recording')
      const onSend = vi.fn()
      render(composer(recording, onSend))
      onScreen()
      fireEvent.keyDown(screen.getByTestId('field'), { key: 'm', code: 'KeyM', ctrlKey: true })
      expect(recording.stopRecording).toHaveBeenCalledTimes(1)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('says how to stop, and how to stop and send, while dictating', () => {
      render(composer(voice('recording'), vi.fn()))
      const hint = screen.getAllByTestId('dictation-hint')[0]
      expect(hint).toHaveTextContent(/M\s*Stop\s*·\s*↵\s*Stop and send/)
    })

    it('offers only the stop where there is nothing to send', () => {
      render(composer(voice('recording')))
      const hint = screen.getAllByTestId('dictation-hint')[0]
      expect(hint).toHaveTextContent(/Stop dictating/)
      expect(hint).not.toHaveTextContent('↵')
    })

    it('shows no hint while idle', () => {
      render(composer(voice('idle'), vi.fn()))
      expect(screen.queryByTestId('dictation-hint')).toBeNull()
    })

    it('sends on Enter while dictating, from the field or from the mic itself', () => {
      const onSend = vi.fn()
      render(composer(voice('recording'), onSend))
      const fromField = fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter' })
      expect(onSend).toHaveBeenCalledTimes(1)
      // Taken: the field does not also get a newline, the mic is not also pressed.
      expect(fromField).toBe(false)
      fireEvent.keyDown(screen.getByTestId('voice-input-button'), { key: 'Enter' })
      expect(onSend).toHaveBeenCalledTimes(2)
    })

    it('leaves Shift+Enter, and Enter elsewhere on the page, alone', () => {
      const onSend = vi.fn()
      render(
        <>
          {composer(voice('recording'), onSend)}
          <input data-testid="elsewhere" />
        </>,
      )
      fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter', shiftKey: true })
      fireEvent.keyDown(screen.getByTestId('elsewhere'), { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
    })

    it('does not take Enter when not dictating', () => {
      const onSend = vi.fn()
      render(composer(voice('idle'), onSend))
      expect(fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter' })).toBe(true)
      expect(onSend).not.toHaveBeenCalled()
    })

    it('holds an Enter pressed while the last words come in, and sends once they have', () => {
      const onSend = vi.fn()
      const view = render(composer(voice('finalizing'), onSend))
      fireEvent.keyDown(screen.getByTestId('field'), { key: 'Enter' })
      expect(onSend).not.toHaveBeenCalled()
      view.rerender(composer(voice('idle'), onSend))
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('hands the keyboard back to the field when dictation ends with focus on the mic', async () => {
      const view = render(composer(voice('recording')))
      screen.getByTestId('voice-input-button').focus()
      view.rerender(composer(voice('idle')))
      await vi.waitFor(() => expect(screen.getByTestId('field')).toHaveFocus())
      const field = screen.getByTestId<HTMLTextAreaElement>('field')
      expect(field.selectionStart).toBe(field.value.length)
    })
  })
})
