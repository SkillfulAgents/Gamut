import { useRef, useState } from 'react'
import { useAgent } from '@renderer/hooks/use-agents'
import { AgentIntegrationApiError, useCreateAgentIntegration, useTestAgentIntegrationCredentials } from '@renderer/hooks/use-agent-integrations'
import { ChatSetupBehavior, DEFAULT_CHAT_SETUP_BEHAVIOR, SETTINGS_STEP_LABEL, SETTINGS_STEP_SUBTITLE } from './chat-setup-behavior'
import { IntegrationSetupAdvanced, IntegrationSetupCode, IntegrationSetupFeedback, IntegrationSetupField, IntegrationSetupList } from './integration-setup-layout'
import { IntegrationSetupWizard, IntegrationSetupWizardLink } from './integration-setup-wizard'
import type { IntegrationSetupProps } from './setup-types'
import { useIntegrationSetupName } from './use-integration-setup-name'

export function TelegramSetupForm({ agentSlug, initial, onClose }: IntegrationSetupProps) {
  const { data: agent } = useAgent(agentSlug)
  const verification = useTestAgentIntegrationCredentials()
  const create = useCreateAgentIntegration()
  const [step, setStep] = useState(0)
  const [botToken, setBotToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [missingToken, setMissingToken] = useState(false)
  const [connected, setConnected] = useState(false)
  const tokenCheck = useRef<{ pending?: ReturnType<typeof verification.mutateAsync> }>({})

  const bot = verification.data?.valid ? verification.data : undefined
  const botName = bot?.botName?.trim()
  const username = bot?.botUsername?.trim()
  const defaultName = botName || username || initial?.name?.trim()
  const name = useIntegrationSetupName(defaultName || agent?.name || agentSlug)
  const readOnly = connected || create.isPending
  const tokenError = missingToken ? 'Paste the bot token first.' : verification.error?.message ??
    (verification.data?.valid === false ? 'Invalid bot token' : undefined)

  function changeToken(value: string) {
    setBotToken(value)
    setMissingToken(false)
    tokenCheck.current = {}
    verification.reset()
  }

  async function verify(continueToSettings: boolean) {
    const token = botToken.trim()
    if (!token) {
      setMissingToken(true)
      return
    }
    if (bot && continueToSettings && !tokenCheck.current.pending) {
      setStep(1)
      return
    }
    // Next can join a check started by Verify. Editing the token retires that check.
    const check = tokenCheck.current
    try {
      check.pending ??= verification.mutateAsync({ provider: 'telegram', config: { botToken: token } })
      const result = await check.pending
      if (check === tokenCheck.current && result.valid && continueToSettings) setStep(1)
    } catch {
      // The mutation supplies the inline error.
    } finally {
      check.pending = undefined
    }
  }

  function changeStep(next: number) {
    if (create.isPending) return
    if (connected || next === 0) setStep(next)
    else if (next === 1) void verify(true)
  }

  async function connect() {
    if (!bot || readOnly) return
    try {
      await create.mutateAsync({
        agentSlug, provider: 'telegram', name: name.override ?? defaultName,
        config: { botToken: botToken.trim(), ...(chatId ? { chatId } : {}) },
        showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout,
      })
      setConnected(true)
      setStep(2)
    } catch {
      // The connection error is shown on the settings step.
    }
  }

  return <IntegrationSetupWizard provider="telegram" label="Telegram" heading="Chat with this agent over Telegram"
    description="Chat with this agent in Telegram, through a bot of its own." step={step} onStepChange={changeStep} complete={connected}
    steps={[
      {
        label: 'Create a bot',
        content: <>
          <IntegrationSetupList items={[
            <>In Telegram, open a chat with <IntegrationSetupWizardLink href="https://t.me/BotFather">@BotFather</IntegrationSetupWizardLink>.</>,
            <>Send <IntegrationSetupCode>/newbot</IntegrationSetupCode>.</>,
            'Give the bot a name and a username ending in “bot”.',
            <>Paste the token BotFather sends back.<div className="mt-2">
              <IntegrationSetupField id="setup-botToken" label="Paste the token BotFather sends back" hideLabel type="password"
                placeholder="123456789:ABCdefGHIjklMNO…" value={botToken} onChange={event => changeToken(event.target.value)}
                disabled={readOnly} aria-invalid={!!tokenError}
                action={connected ? undefined : { label: 'Verify', busyLabel: 'Verifying…', busy: verification.isPending, onClick: () => void verify(false) }} />
            </div></>,
          ]} />
          {tokenError && <IntegrationSetupFeedback state="error">{tokenError}</IntegrationSetupFeedback>}
          {bot && <IntegrationSetupFeedback state="success">
            Bot token verified{botName && ` for ${botName}`}{username && ` (@${username})`}.
          </IntegrationSetupFeedback>}
        </>,
      },
      {
        label: SETTINGS_STEP_LABEL, subtitle: SETTINGS_STEP_SUBTITLE,
        content: <>
          <IntegrationSetupField id="setup-integration-name" label="Integration name" {...name.input} disabled={readOnly} />
          <ChatSetupBehavior provider="telegram" value={behavior} onChange={setBehavior} disabled={readOnly} />
          <IntegrationSetupAdvanced>
            <IntegrationSetupField id="setup-chatId" label="Chat ID" optional placeholder="Auto-detected on first message"
              value={chatId} onChange={event => setChatId(event.target.value)} disabled={readOnly} />
          </IntegrationSetupAdvanced>
          {create.error && <IntegrationSetupFeedback state="error">
            {create.error instanceof AgentIntegrationApiError && create.error.code === 'duplicate_bot_token'
              ? 'This bot is already connected to another integration. Remove the existing one first, or use a different bot.'
              : create.error.message}
          </IntegrationSetupFeedback>}
        </>,
        action: connected ? undefined : { label: 'Connect', busyLabel: 'Connecting…', busy: create.isPending, onClick: () => void connect() },
      },
      {
        label: 'Say hello', disabled: !connected,
        subtitle: <>Open your new bot in Telegram and send <IntegrationSetupCode>/start</IntegrationSetupCode> to begin your first conversation with this agent.</>,
        action: { label: 'Done', onClick: onClose },
      },
    ]}
  />
}
