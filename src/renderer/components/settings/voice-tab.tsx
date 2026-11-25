import { VOICE_PROVIDER_OPTIONS, PROVIDER_CONFIG, isApiKeyProvider, getConversationNotice, type ApiKeyProvider } from '@renderer/lib/voice/registry/catalog'
import { useState, useCallback } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { AlertTriangle, Eye, EyeOff, Check, Loader2, ExternalLink, Square, Volume2 } from 'lucide-react'
import { useIsTtsConfigured, useVoiceConversationEngine, useTtsVoices, useVoiceInput } from '@renderer/hooks/use-voice-input'
import { readAloud } from '@renderer/lib/voice/services/read-aloud'
import { useReadAloud } from '@renderer/hooks/use-read-aloud'
import { VoiceInputButton, VoiceInputError } from '@renderer/components/ui/voice-input-button'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { ApiKeyStatus, VoiceProvider } from '@shared/lib/config/settings'
import { TTS_SPEEDS, resolveHoldSound, resolveTtsSpeed, resolveUserMusic, type TtsVoiceInfo } from '@shared/lib/voice/tts-preferences'
import { userMusicSupported } from '@renderer/hooks/use-user-music'
import { MicrophoneSettings } from './microphone-settings'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'
import { cn } from '@shared/lib/utils/cn'

function SttApiKeyInput({ provider, disabled }: { provider: ApiKeyProvider; disabled: boolean }) {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const config = PROVIDER_CONFIG[provider]

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{ valid: boolean; error?: string } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)

  const apiKeyStatus: ApiKeyStatus | undefined = settings?.apiKeyStatus?.[config.statusField]
  const isBusy = isValidating || isRemoving

  const handleValidateAndSave = async () => {
    if (!apiKeyInput.trim()) return
    setIsValidating(true)
    setValidationResult(null)

    try {
      const res = await apiFetch('/api/settings/validate-stt-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: apiKeyInput.trim() }),
      })
      const result = await res.json()
      setValidationResult(result)

      if (result.valid) {
        await updateSettings.mutateAsync({
          apiKeys: { [config.apiKeyField]: apiKeyInput.trim() },
        })
        setApiKeyInput('')
        setShowApiKey(false)
      }
    } catch {
      setValidationResult({ valid: false, error: 'Failed to validate API key' })
    } finally {
      setIsValidating(false)
    }
  }

  const handleRemoveApiKey = async () => {
    setIsRemoving(true)
    try {
      await updateSettings.mutateAsync({
        apiKeys: { [config.apiKeyField]: '' },
      })
      setValidationResult(null)
    } catch (error) {
      console.error('Failed to remove API key:', error)
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={`${provider}-api-key`}>
        {VOICE_PROVIDER_OPTIONS.find(p => p.value === provider)?.label} API Key
      </Label>

      {apiKeyStatus?.isConfigured && (
        <div className="flex items-center gap-2">
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              apiKeyStatus.source === 'settings'
                ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                : 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
            }`}
          >
            {apiKeyStatus.source === 'settings'
              ? 'Using saved setting'
              : 'Using environment variable'}
          </span>
        </div>
      )}

      <div className="relative">
        <Input
          id={`${provider}-api-key`}
          type={showApiKey ? 'text' : 'password'}
          value={apiKeyInput}
          onChange={(e) => {
            setApiKeyInput(e.target.value)
            setValidationResult(null)
          }}
          placeholder={apiKeyStatus?.isConfigured ? '••••••••••••••••' : config.placeholder}
          className="pr-10"
          disabled={disabled || isBusy}
        />
        <button
          type="button"
          onClick={() => setShowApiKey(!showApiKey)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          disabled={disabled || isBusy}
        >
          {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>

      {validationResult && (
        <Alert variant={validationResult.valid ? 'default' : 'destructive'}>
          {validationResult.valid ? (
            <Check className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          <AlertDescription>
            {validationResult.valid
              ? 'API key is valid and has been saved.'
              : validationResult.error || 'Invalid API key'}
          </AlertDescription>
        </Alert>
      )}

      <p className="text-xs text-muted-foreground">
        {apiKeyStatus?.source === 'settings'
          ? 'Your API key is saved locally. Enter a new key to replace it.'
          : apiKeyStatus?.source === 'env'
            ? `Save a key here to override the ${config.envVar} environment variable.`
            : (
              <>
                Get your API key from the{' '}
                <a
                  href={config.dashboardUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {config.dashboardLabel}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
      </p>

      <div className="flex gap-2">
        {apiKeyInput.trim() && (
          <Button size="sm" onClick={handleValidateAndSave} disabled={isBusy}>
            {isValidating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Validating...
              </>
            ) : (
              'Validate & save'
            )}
          </Button>
        )}
        {apiKeyStatus?.source === 'settings' && (
          <Button
            size="sm"
            variant="soft"
            onClick={handleRemoveApiKey}
            disabled={isBusy}
          >
            {isRemoving ? 'Removing...' : 'Remove saved key'}
          </Button>
        )}
      </div>
    </div>
  )
}

function VoiceTest() {
  const [transcript, setTranscript] = useState('')

  const voiceInput = useVoiceInput({
    onTranscriptUpdate: useCallback((text: string) => {
      setTranscript(text)
    }, []),
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <VoiceInputButton voiceInput={voiceInput} message="" size="sm" />
        <span className="text-sm text-muted-foreground">
          {voiceInput.isConnecting
            ? 'Connecting...'
            : voiceInput.isFinalizing
              ? 'Finishing…'
              : voiceInput.isRecording
                ? 'Listening — speak now'
                : 'Click to test voice input'}
        </span>
      </div>

      {(transcript || voiceInput.isRecording) && (
        <div className="rounded-card border bg-muted/50 p-3 text-sm min-h-[60px]">
          {!transcript && voiceInput.isRecording && (
            <span className="text-muted-foreground/60 italic animate-pulse">
              Listening... speak now
            </span>
          )}
          {transcript}
        </div>
      )}

      <VoiceInputError error={voiceInput.error} onDismiss={voiceInput.clearError} />
    </div>
  )
}

const VALID_PROVIDERS = new Set(VOICE_PROVIDER_OPTIONS.map(p => p.value))

const VOICE_PREVIEW_ID = 'settings-voice-preview'
const VOICE_PREVIEW_TEXT = 'Hi! This is how your agent will sound when it reads a reply out loud.'

function VoicePreviewRow() {
  const { status, toggle, error } = useReadAloud(VOICE_PREVIEW_ID, VOICE_PREVIEW_TEXT)
  const busy = status === 'connecting'
  return (
    <SettingRow
      name="Hear a sample"
      right={
        <Button size="sm" variant="soft" onClick={toggle} disabled={busy} data-testid="voice-preview-button">
          {busy ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : status === 'speaking' ? (
            <Square className="h-4 w-4 mr-2 fill-current" />
          ) : (
            <Volume2 className="h-4 w-4 mr-2" />
          )}
          {status === 'speaking' ? 'Stop' : 'Preview voice'}
        </Button>
      }
    >
      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </SettingRow>
  )
}

/** Picker value meaning "no personal pick: follow the workspace default". */
const WORKSPACE_DEFAULT = 'workspace-default'

function voiceLabel(voices: readonly TtsVoiceInfo[], voice: string): string {
  return voices.find((v) => v.id === voice)?.label ?? voice
}

/**
 * The voice ids are the provider's own, so the list comes from the configured
 * provider (via the member-readable status endpoint), not from a shared
 * constant.
 */
function VoicePicker({ id, voices, value, onChange, disabled, workspaceDefault }: {
  id: string
  voices: readonly TtsVoiceInfo[]
  /** A voice, or null for "follow the workspace default" (only when one is offered). */
  value: string | null
  onChange: (voice: string | null) => void
  disabled: boolean
  /** Offer following the workspace default, labelled with this voice. */
  workspaceDefault?: string
}) {
  // The list describes each voice; the row shows only the pick's name.
  const picked = value
    ? voiceLabel(voices, value)
    : workspaceDefault ? `Workspace Default (${voiceLabel(voices, workspaceDefault)})` : undefined
  return (
    <Select
      variant="row"
      value={value ?? WORKSPACE_DEFAULT}
      onValueChange={(v) => {
        if (v === WORKSPACE_DEFAULT) onChange(null)
        else if (voices.some((voice) => voice.id === v)) onChange(v)
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue>{picked}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {workspaceDefault && (
          <SelectItem value={WORKSPACE_DEFAULT}>Workspace Default ({voiceLabel(voices, workspaceDefault)})</SelectItem>
        )}
        {voices.map((v) => (
          <SelectItem key={v.id} value={v.id}>
            {v.label}
            <span className="text-muted-foreground ml-2">({v.description})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The reader's own voice and pace. Per user: stored in user settings, read
 * by the token endpoint, so everyone in a shared deployment hears their own
 * pick. In a shared deployment the picker also offers following the
 * workspace default, which is what everyone gets until they choose.
 *
 * Reads no deployment settings: that endpoint is admin-only, and this
 * section is a member's whole tab.
 */
function PersonalVoiceSection({ heading, offerWorkspaceDefault }: { heading: string; offerWorkspaceDefault: boolean }) {
  const { voices, defaultVoice: workspaceDefault } = useTtsVoices()
  const { data: userSettings, isLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const speed = resolveTtsSpeed(userSettings?.voice?.ttsSpeed)
  // A stored pick the current provider does not offer reads as no pick.
  const stored = userSettings?.voice?.ttsVoice
  const ownVoice = stored && voices.some((v) => v.id === stored) ? stored : null
  const speedOption = TTS_SPEEDS.find((s) => s.value === speed)
  const holdSound = resolveHoldSound(userSettings?.voice?.holdSound)
  const userMusic = resolveUserMusic(userSettings?.voice?.userMusic)

  return (
    <div className="space-y-2" data-testid="personal-voice-section">
      <h3 className={SETTINGS_SECTION_HEADING}>{heading}</h3>
      <div className={SETTINGS_CARD_CLASS}>
        <SettingRow
          name="Voice"
          help="Used when an agent's reply is read aloud. Only you hear your choice."
          htmlFor="tts-voice"
          right={
            <VoicePicker
              id="tts-voice"
              voices={voices}
              value={offerWorkspaceDefault ? ownVoice : (ownVoice ?? workspaceDefault ?? null)}
              disabled={isLoading}
              workspaceDefault={offerWorkspaceDefault ? workspaceDefault : undefined}
              onChange={(ttsVoice) => updateUserSettings.mutate({ voice: { ttsVoice } }, { onSuccess: () => readAloud.restart() })}
            />
          }
        />
        <SettingRow
          name="Speed"
          htmlFor="tts-speed"
          right={
            <Select
              variant="row"
              value={String(speed)}
              onValueChange={(v) => updateUserSettings.mutate({ voice: { ttsSpeed: Number(v) } }, { onSuccess: () => readAloud.restart() })}
              disabled={isLoading}
            >
              <SelectTrigger id="tts-speed">
                {/* A stored speed off the preset list still needs a readable trigger. */}
                <SelectValue>{speedOption?.label ?? `${speed}×`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TTS_SPEEDS.map((s) => (
                  <SelectItem key={s.value} value={String(s.value)}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <VoicePreviewRow />
        <SettingRow
          name="Hold sound in voice mode"
          help="A soft loop while the agent works, so silence never reads as a dropped call."
          htmlFor="voice-hold-sound"
          right={
            <Switch
              id="voice-hold-sound"
              checked={holdSound}
              disabled={isLoading}
              onCheckedChange={(holdSound) => updateUserSettings.mutate({ voice: { holdSound } })}
            />
          }
        />
        {userMusicSupported() && (
          <SettingRow
            name="Use my music as the hold sound"
            help="When Spotify, Music or a browser is already playing, voice mode pauses it while anyone speaks and, with the hold sound on, lets it play while the agent works."
            htmlFor="voice-user-music"
            right={
              <Switch
                id="voice-user-music"
                checked={userMusic}
                disabled={isLoading}
                onCheckedChange={(userMusic) => updateUserSettings.mutate({ voice: { userMusic } })}
              />
            }
          />
        )}
      </div>
    </div>
  )
}

/**
 * Admin, shared deployments only: what people hear until they pick their own
 * voice. The status endpoint already resolves the stored default against the
 * provider's catalogue (and a settings save invalidates it), so it is read
 * from there rather than re-derived from the raw setting.
 */
function DefaultVoiceSection({ disabled }: { disabled: boolean }) {
  const { voices, defaultVoice } = useTtsVoices()
  const updateSettings = useUpdateSettings()

  return (
    <div className="space-y-2" data-testid="default-voice-section">
      <h3 className={SETTINGS_SECTION_HEADING}>Default voice</h3>
      <div className={SETTINGS_CARD_CLASS}>
        <SettingRow
          name="Voice for anyone who hasn't picked their own"
          htmlFor="tts-default-voice"
          right={
            <VoicePicker
              id="tts-default-voice"
              voices={voices}
              value={defaultVoice ?? null}
              disabled={disabled}
              onChange={(ttsVoice) => { if (ttsVoice) updateSettings.mutate({ voice: { ttsVoice } }) }}
            />
          }
        />
      </div>
    </div>
  )
}

export function VoiceTab() {
  const { isAuthMode, isAdmin } = useUser()
  // Provider and key are deployment-wide, so admins only. The personal
  // section is everyone's — it is the whole tab for members. The settings
  // endpoint is admin-only too, so members must not even ask for it.
  const showAdminFeatures = !isAuthMode || isAdmin
  const { data: settings, isLoading } = useSettings({ enabled: showAdminFeatures })
  const updateSettings = useUpdateSettings()
  const { data: platformAuth } = usePlatformAuthStatus()
  const ttsAvailable = useIsTtsConfigured()
  const conversationEngine = useVoiceConversationEngine()
  const conversationNotice = getConversationNotice(conversationEngine)
  const isPlatformConnected = platformAuth?.connected ?? false
  const rawProvider = settings?.voice?.sttProvider
  const selectedProvider = rawProvider && VALID_PROVIDERS.has(rawProvider) ? rawProvider : undefined

  const hasKeyConfigured = selectedProvider && (
    selectedProvider === 'platform'
      ? isPlatformConnected
      : isApiKeyProvider(selectedProvider) && settings?.apiKeyStatus?.[PROVIDER_CONFIG[selectedProvider].statusField]?.isConfigured
  )

  const providerInfo = selectedProvider ? VOICE_PROVIDER_OPTIONS.find(p => p.value === selectedProvider) : undefined

  return (
    <div className="space-y-6">
      <MicrophoneSettings />

      {ttsAvailable && (
        <PersonalVoiceSection heading={isAuthMode ? 'Your voice' : 'Text-to-speech'} offerWorkspaceDefault={isAuthMode} />
      )}

      {conversationNotice && (
        <p className="px-1 text-[11px] text-muted-foreground">
          {conversationNotice}
        </p>
      )}
      {!ttsAvailable && !conversationEngine && !showAdminFeatures && (
        <p className="px-1 text-[11px] text-muted-foreground" data-testid="voice-unavailable-note">
          Text-to-speech isn&apos;t set up for this workspace yet. Ask an admin to configure a voice provider.
        </p>
      )}

      {showAdminFeatures && (
        <>
          <div className="space-y-2">
            <h3 className={SETTINGS_SECTION_HEADING}>Voice provider</h3>
            <div className={SETTINGS_CARD_CLASS}>
              <SettingRow
                name="Provider"
                htmlFor="stt-provider"
                // What the selected provider needs and costs: it changes with the pick.
                status={providerInfo && (
                  <>
                    {providerInfo.note}
                    {providerInfo.docsUrl && (
                      <>
                        {' '}
                        <a
                          href={providerInfo.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-0.5"
                        >
                          View details
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </>
                    )}
                  </>
                )}
                right={
                  <Select
                    variant="row"
                    value={selectedProvider ?? ''}
                    onValueChange={(value) => {
                      if (value === 'platform' && !isPlatformConnected) return
                      updateSettings.mutate({ voice: { sttProvider: value as VoiceProvider } })
                    }}
                    disabled={isLoading}
                  >
                    <SelectTrigger id="stt-provider">
                      {/* The list names each provider's models; the row shows only the provider. */}
                      <SelectValue placeholder="Select a provider">{providerInfo?.label}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {VOICE_PROVIDER_OPTIONS.map((provider) => (
                        <SelectItem
                          key={provider.value}
                          value={provider.value}
                          disabled={'platformOnly' in provider && provider.platformOnly && !isPlatformConnected}
                        >
                          {provider.label}
                          {'platformOnly' in provider && provider.platformOnly && !isPlatformConnected
                            ? <span className="text-muted-foreground ml-2">(requires platform login)</span>
                            : <span className="text-muted-foreground ml-2">({provider.model})</span>
                          }
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
            </div>
          </div>

          {selectedProvider && isApiKeyProvider(selectedProvider) && (
            <div className="space-y-2">
              <h3 className={SETTINGS_SECTION_HEADING}>API key</h3>
              <div className={cn(SETTINGS_CARD_CLASS, 'py-3 px-4')}>
                <SttApiKeyInput key={selectedProvider} provider={selectedProvider} disabled={isLoading} />
              </div>
            </div>
          )}

          {ttsAvailable && isAuthMode && <DefaultVoiceSection disabled={isLoading} />}

          {hasKeyConfigured && selectedProvider && (
            <div className="space-y-2">
              <h3 className={SETTINGS_SECTION_HEADING}>Test</h3>
              <div className={cn(SETTINGS_CARD_CLASS, 'py-3 px-4')}>
                <VoiceTest />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
