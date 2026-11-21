/**
 * Chat provider setup, including the manual Slack Socket Mode flow.
 */

import { useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { ChatSetupBehavior, DEFAULT_CHAT_SETUP_BEHAVIOR, SETTINGS_STEP_LABEL, SETTINGS_STEP_SUBTITLE, slackBehaviorConfig } from './chat-setup-behavior'
import { useIntegrationSetupName, type IntegrationSetupName } from './use-integration-setup-name'
import type { IntegrationSetupProps } from './setup-types'
import { IntegrationSetupField, IntegrationSetupFeedback, IntegrationSetupAdvanced, IntegrationSetupNote, IntegrationSetupCode } from './integration-setup-layout'
import { IntegrationSetupWizard, IntegrationSetupWizardLink, type IntegrationSetupWizardStep } from './integration-setup-wizard'
import {
  useCreateAgentIntegration,
  useTestAgentIntegrationCredentials,
  AgentIntegrationApiError,
} from '@renderer/hooks/use-agent-integrations'
import { Copy, Check } from 'lucide-react'
import { IMESSAGE_PHONE_E164, type ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { SLACK_BOT_EVENTS, SLACK_BOT_SCOPES, slackAppManifest, type SlackAppIdentity } from '@shared/lib/chat-integrations/slack-manifest'
import { useAgent } from '@renderer/hooks/use-agents'
import { slackAppIconStep } from './slack-app-appearance'
import { slackAppIdentity, type SlackAppAgent } from './slack-app-identity'
import { TelegramSetupForm } from './telegram-setup-form'

function generateSlackManifest(app: SlackAppIdentity): string {
  return JSON.stringify(slackAppManifest(app), null, 2)
}

const IMESSAGE_SETUP_NUMBER_DISPLAY = '+1 (205) 396-7934'

function PhoneNumberCopyButton() {
  const smsUrl = `sms:${IMESSAGE_PHONE_E164}&body=${encodeURIComponent('/setup')}`
  return (
    <a
      href={smsUrl}
      onClick={(e) => {
        if (window.electronAPI) {
          e.preventDefault()
          window.electronAPI.openExternal(smsUrl)
        }
      }}
      className="underline text-primary hover:text-primary/80 whitespace-nowrap"
    >
      {IMESSAGE_SETUP_NUMBER_DISPLAY}
    </a>
  )
}

const SLACK_APPS_URL = 'https://api.slack.com/apps'

/** Scopes or events to add one by one in Slack: a block the eye can run down. */
function SlackNames({ names }: { names: string[] }) {
  return <ul className="flex flex-wrap gap-1.5">
    {names.map(name => <li key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{name}</li>)}
  </ul>
}

type ManualChatProvider = Exclude<ChatProvider, 'telegram' | 'teams'>

/** Under each setup's heading: what connecting gets you. */
const CHAT_DESCRIPTIONS: Record<ManualChatProvider, string> = {
  slack: 'DM this agent in Slack, or mention it in channels.',
  imessage: 'Text this agent from your phone.',
}

const PROVIDER_INFO: Record<ManualChatProvider, {
  label: string
  /** `optional` fields sit under Options: the setup works without them. */
  fields: Array<{ key: string; label: string; placeholder: string; type: 'text' | 'password'; optional?: boolean }>
}> = {
  slack: {
    label: 'Slack',
    fields: [
      { key: 'appToken', label: 'App-Level Token', placeholder: 'xapp-…', type: 'password' as const },
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-…', type: 'password' as const },
      { key: 'channelId', label: 'Channel ID', placeholder: 'Auto-detected from DMs', type: 'text' as const, optional: true },
    ],
  },
  imessage: {
    label: 'iMessage',
    fields: [
      { key: 'phoneNumber', label: 'Your phone number', placeholder: '+15551234567', type: 'text' as const },
      { key: 'code', label: 'Setup code', placeholder: '6-digit code', type: 'text' as const },
    ],
  },
}

/** A wizard step, plus the required fields it holds: an empty one brings the person back to it. */
type ChatSetupStep = IntegrationSetupWizardStep & { fields?: string[] }

export function ChatIntegrationSetupForm({ provider, ...props }: IntegrationSetupProps & { provider: Exclude<ChatProvider, 'teams'> }) {
  if (provider === 'telegram') return <TelegramSetupForm {...props} />
  return <ManualChatSetupForm {...props} provider={provider} />
}

function ManualChatSetupForm(props: IntegrationSetupProps & { provider: ManualChatProvider }) {
  const { data: agent } = useAgent(props.agentSlug)
  const name = useIntegrationSetupName(agent?.name || props.agentSlug, props.initial?.name)
  return <ChatSetupSteps {...props} agent={agent} name={name} />
}

export function ChatSetupSteps({ agentSlug, provider, onClose, leading, agent, name }: IntegrationSetupProps & {
  provider: ManualChatProvider
  agent: SlackAppAgent | undefined
  name: IntegrationSetupName
  leading?: ReactNode
}) {
  const createIntegration = useCreateAgentIntegration()
  const testCredentials = useTestAgentIntegrationCredentials()

  const [formData, setFormData] = useState<Record<string, string>>({})
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [testResult, setTestResult] = useState<{ valid: boolean; info?: string } | null>(null)
  const [slackSetupMode, setSlackSetupMode] = useState<'manifest' | 'manual'>('manifest')
  const [manifestCopied, setManifestCopied] = useState(false)
  const slackApp = slackAppIdentity(agent, name.effective)

  const info = PROVIDER_INFO[provider]
  const [step, setStep] = useState(0)
  const readOnly = createIntegration.isPending
  const nameField = <IntegrationSetupField id="setup-integration-name" label={provider === 'slack' ? 'App name' : 'Integration name'} {...name.input} disabled={readOnly} />

  const field = (key: string, { label, verify, hideLabel }: { label?: string; verify?: boolean; hideLabel?: boolean } = {}) => {
    const spec = info.fields.find(f => f.key === key)
    if (!spec) return null
    return <IntegrationSetupField
      key={spec.key} id={`setup-${spec.key}`} label={label ?? spec.label} hideLabel={hideLabel} optional={spec.optional}
      action={verify ? verifyAction : undefined}
      type={spec.type} value={formData[spec.key] || ''}
      onChange={e => setFormData({ ...formData, [spec.key]: e.target.value })}
      placeholder={spec.placeholder}
      disabled={readOnly}
    />
  }

  // Everything the setup works without, in a step of its own before connecting.
  const optionsStep: ChatSetupStep = {
    label: SETTINGS_STEP_LABEL,
    subtitle: SETTINGS_STEP_SUBTITLE,
    content: <>
      {provider !== 'slack' && nameField}
      <ChatSetupBehavior provider={provider} value={behavior} onChange={setBehavior} disabled={readOnly} />
      {info.fields.some(spec => spec.optional) && <IntegrationSetupAdvanced>
        {info.fields.filter(spec => spec.optional).map(spec => field(spec.key))}
      </IntegrationSetupAdvanced>}
    </>,
  }
  // Called only on click, after the handlers below exist.
  const connectAction = { label: 'Connect', busyLabel: 'Connecting…', busy: createIntegration.isPending, onClick: () => void handleCreate() }
  const verifyAction = { label: 'Verify', busyLabel: 'Verifying…', busy: testCredentials.isPending, onClick: () => void handleTest() }

  const switchSlackMode = (mode: 'manifest' | 'manual') => { setSlackSetupMode(mode); setStep(0) }
  const modeSwitch = (label: ReactNode, mode: 'manifest' | 'manual') => (
    <button type="button" className="underline text-primary hover:text-primary/80" onClick={() => switchSlackMode(mode)}>{label}</button>
  )
  const appTokenStep: ChatSetupStep = {
    label: 'Paste the app token',
    subtitle: <>In Slack, go to <strong>Basic Information → App-Level Tokens</strong> and generate a token with the <IntegrationSetupCode>connections:write</IntegrationSetupCode> scope. Then copy it.</>,
    content: field('appToken'),
    fields: ['appToken'],
  }
  const botTokenStep: ChatSetupStep = {
    label: 'Paste the bot token',
    subtitle: <>In Slack, go to <strong>OAuth &amp; Permissions</strong> and install the app to your workspace. Then copy the <strong>Bot User OAuth Token</strong> (xoxb-…).</>,
    content: field('botToken', { verify: true }),
    fields: ['botToken'],
  }
  // The agent's avatar as the app's icon: a step only for an agent that has one.
  const iconStep = (options?: { withColor?: boolean }): ChatSetupStep[] => {
    const step = slackAppIconStep(agent, { name: name.effective, ...options })
    return step ? [step] : []
  }

  const steps: ChatSetupStep[] = provider === 'imessage' ? [
    {
      label: 'Get a setup code',
      subtitle: <>From the phone you want to connect, text <IntegrationSetupCode>/setup</IntegrationSetupCode> to <PhoneNumberCopyButton />. You’ll get a 6-digit code back.</>,
      content: <IntegrationSetupNote>Only one agent can connect to iMessage, so choose one that can reach all your other agents.</IntegrationSetupNote>,
    },
    {
      label: 'Enter the code',
      subtitle: 'Enter the phone number you texted from and the code you got back.',
      content: <>
        {field('phoneNumber')}{field('code')}
        <IntegrationSetupNote>Codes expire after 15 minutes. Text <IntegrationSetupCode>/setup</IntegrationSetupCode> again for a new one.</IntegrationSetupNote>
      </>,
      fields: ['phoneNumber', 'code'],
    },
    optionsStep,
  ] : slackSetupMode === 'manifest' ? [
    {
      label: 'Copy the manifest',
      subtitle: 'The manifest sets up the Slack app for you. You’ll paste it into Slack in the next step.',
      content: <>
        {nameField}
        {leading}
        {/* Always shown, with its copy button pinned to the corner: outside the scrolling text, so it stays put. */}
        <div className="relative">
          <pre className="max-h-44 overflow-auto rounded-card border bg-muted/40 p-3 pr-24 text-2xs leading-relaxed select-all" data-testid="slack-manifest">
            {generateSlackManifest(slackApp)}
          </pre>
          <Button
            type="button" variant="outline" size="sm" className="absolute right-2 top-2 h-7 gap-1.5 bg-background px-2 text-xs"
            aria-label={manifestCopied ? 'Manifest copied' : 'Copy manifest'} data-testid="slack-manifest-copy"
            onClick={async () => {
              await navigator.clipboard.writeText(generateSlackManifest(slackApp))
              setManifestCopied(true)
              setTimeout(() => setManifestCopied(false), 2000)
            }}
          >
            {manifestCopied ? <><Check className="h-3.5 w-3.5" aria-hidden="true" /> Copied</> : <><Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy</>}
          </Button>
        </div>
        <IntegrationSetupNote>Prefer to add each setting yourself? {modeSwitch('Set up from scratch', 'manual')}</IntegrationSetupNote>
      </>,
    },
    {
      label: 'Create the app',
      subtitle: <>Open Slack’s app page and choose <strong>Create New App → From a manifest</strong>. Pick your workspace, then paste the manifest in place of Slack’s.</>,
      content: <>
        <IntegrationSetupWizardLink href={SLACK_APPS_URL}>Open api.slack.com/apps</IntegrationSetupWizardLink>
      </>,
    },
    appTokenStep,
    // On the page the app token comes from, so it follows it.
    ...iconStep(),
    botTokenStep,
    optionsStep,
  ] : [
    {
      label: 'Create the app',
      subtitle: <>Open Slack’s app page and choose <strong>Create New App → From scratch</strong>. Name the app and pick your workspace.</>,
      content: <>
        {nameField}
        {leading}
        <IntegrationSetupWizardLink href={SLACK_APPS_URL}>Open api.slack.com/apps</IntegrationSetupWizardLink>
        <IntegrationSetupNote>Rather not add each setting yourself? {modeSwitch('Use a manifest instead', 'manifest')}</IntegrationSetupNote>
      </>,
    },
    { label: 'Turn on Socket Mode', subtitle: <>In Slack, go to <strong>Settings → Socket Mode</strong> and turn it on.</> },
    appTokenStep,
    // An app made from scratch has no colour either.
    ...iconStep({ withColor: true }),
    {
      label: 'Add the bot scopes',
      subtitle: <>In Slack, go to <strong>OAuth &amp; Permissions → Scopes → Bot Token Scopes</strong> and add each of these.</>,
      content: <SlackNames names={SLACK_BOT_SCOPES} />,
    },
    {
      label: 'Add the bot events',
      subtitle: <>In Slack, go to <strong>Event Subscriptions</strong>, turn it on and add each of these bot events.</>,
      content: <SlackNames names={SLACK_BOT_EVENTS} />,
    },
    { label: 'Turn on Interactivity', subtitle: <>In Slack, go to <strong>Interactivity &amp; Shortcuts</strong> and turn it on.</> },
    {
      label: 'Allow direct messages',
      subtitle: <>In Slack, go to <strong>App Home → Show Tabs</strong>. Turn on <strong>Messages Tab</strong>, then check <strong>Allow users to send Slash commands and messages from the messages tab</strong>.</>,
    },
    botTokenStep,
    optionsStep,
  ]

  // Returns an error message string when required fields are missing, else null.
  const validateRequired = (): string | null => {
    const missingRequired = info.fields.some((f) => !f.optional && !formData[f.key]?.trim())
    if (!missingRequired) return null
    if (provider === 'slack') return 'Paste the app token and the bot token first.'
    return 'Enter your phone number and setup code first.'
  }

  const handleTest = async () => {
    setTestResult(null)
    const missing = validateRequired()
    if (missing) {
      setTestResult({ valid: false, info: missing })
      return
    }
    try {
      const result = await testCredentials.mutateAsync({ provider, config: formData })
      const detail = provider === 'slack'
        ? `Workspace: ${result.team}`
        : `Connected: ${result.phoneNumber || 'OK'}`
      setTestResult({ valid: true, info: detail })
    } catch (err) {
      setTestResult({ valid: false, info: err instanceof Error ? err.message : 'Invalid credentials' })
    }
  }

  const handleCreate = async () => {
    const missing = validateRequired()
    if (missing) {
      const emptyAt = steps.findIndex(s => s.fields?.some(key => !formData[key]?.trim()))
      if (emptyAt >= 0) setStep(emptyAt)
      setTestResult({ valid: false, info: missing })
      return
    }
    try {
      const config: Record<string, unknown> = { ...formData, ...(provider === 'slack' ? slackBehaviorConfig(behavior) : {}) }
      if (provider === 'imessage') {
        config.gatewayUrl = 'https://imsgw.com'
      }
      await createIntegration.mutateAsync({
        agentSlug,
        provider,
        name: name.override,
        config,
        showToolCalls: behavior.showToolCalls,
        sessionTimeout: behavior.sessionTimeout,
      })
      onClose()
    } catch {
      // Error surfaced via createIntegration.error
    }
  }

  return (
    <IntegrationSetupWizard
      provider={provider}
      label={info.label}
      description={CHAT_DESCRIPTIONS[provider]}
      steps={steps}
      step={step}
      // A check's result belongs to the step it was made on.
      onStepChange={next => { setStep(next); setTestResult(null) }}
      feedback={(testResult || createIntegration.error) && <>
        {testResult && <IntegrationSetupFeedback state={testResult.valid ? 'success' : 'error'}>{testResult.info}</IntegrationSetupFeedback>}
        {createIntegration.error && (
          <IntegrationSetupFeedback state="error">
            {createIntegration.error instanceof AgentIntegrationApiError && createIntegration.error.code === 'duplicate_bot_token'
              ? provider === 'imessage'
                ? 'This phone number is already connected to another integration. Remove the existing one first.'
                : 'This bot is already connected to another integration. Remove the existing one first, or use a different bot.'
              : createIntegration.error.message}
          </IntegrationSetupFeedback>
        )}
      </>}
      finish={connectAction}
    />
  )
}
