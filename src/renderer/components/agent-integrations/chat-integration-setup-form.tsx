/**
 * Chat integration setup form — provider-specific instructions and credentials.
 *
 * Opened from the agent home "Chat via …" rows or the Chat settings tab.
 * Renders provider-specific instructions, credential fields, credential
 * testing, and creation. One dialog instance handles a single provider; the
 * inner form is keyed by provider so state resets when the provider changes.
 */

import { useState, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { SessionTimeoutSelect } from './integration-settings-controls'
import { DEFAULT_SESSION_TIMEOUT_HOURS } from '@shared/lib/agent-integrations/public'
import { IntegrationSetupField, IntegrationSetupFeedback, IntegrationSetupAdvanced, IntegrationSetupHelp, IntegrationSetupList, IntegrationSetupNote, IntegrationSetupCode } from './integration-setup-layout'
import { IntegrationSetupWizard, IntegrationSetupWizardLink, type IntegrationSetupWizardStep } from './integration-setup-wizard'
import {
  useCreateAgentIntegration,
  useTestAgentIntegrationCredentials,
  AgentIntegrationApiError,
} from '@renderer/hooks/use-agent-integrations'
import { Copy, Check, Eye, EyeOff } from 'lucide-react'
import { IMESSAGE_PHONE_E164, type ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { slackAppManifest, type SlackAppIdentity } from '@shared/lib/chat-integrations/slack-manifest'
import { useAgent } from '@renderer/hooks/use-agents'
import { SlackAppIconAside } from './slack-app-appearance'
import { slackAppIdentity } from './slack-app-identity'

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

/** Under each setup's heading: what connecting gets you. */
const CHAT_DESCRIPTIONS: Record<ChatProvider, string> = {
  telegram: 'Chat with this agent in Telegram, through a bot of its own.',
  slack: 'DM this agent in Slack, or mention it in channels.',
  imessage: 'Text this agent from your phone.',
}

const SLACK_BOT_SCOPES = ['chat:write', 'im:history', 'im:read', 'im:write', 'channels:history', 'channels:read', 'groups:history', 'groups:read', 'mpim:history', 'mpim:read', 'users:read', 'files:read', 'files:write', 'reactions:write']
const SLACK_BOT_EVENTS = ['message.im', 'message.channels', 'message.groups', 'message.mpim']

const PROVIDER_INFO: Record<ChatProvider, {
  label: string
  slug: string
  /** `optional` fields sit under Options: the setup works without them. */
  fields: Array<{ key: string; label: string; placeholder: string; type: 'text' | 'password'; optional?: boolean }>
}> = {
  telegram: {
    label: 'Telegram',
    slug: 'telegram',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '123456789:ABCdefGHIjklMNO…', type: 'password' as const },
      { key: 'chatId', label: 'Chat ID', placeholder: 'Auto-detected on first message', type: 'text' as const, optional: true },
    ],
  },
  slack: {
    label: 'Slack',
    slug: 'slack',
    fields: [
      { key: 'appToken', label: 'App-Level Token', placeholder: 'xapp-…', type: 'password' as const },
      { key: 'botToken', label: 'Bot Token', placeholder: 'xoxb-…', type: 'password' as const },
      { key: 'channelId', label: 'Channel ID', placeholder: 'Auto-detected from DMs', type: 'text' as const, optional: true },
    ],
  },
  imessage: {
    label: 'iMessage',
    slug: 'imessage',
    fields: [
      { key: 'phoneNumber', label: 'Your phone number', placeholder: '+15551234567', type: 'text' as const },
      { key: 'code', label: 'Setup code', placeholder: '6-digit code', type: 'text' as const },
    ],
  },
}

/** The step of toggles every chat setup has, named and introduced the same way in each. */
export const SETTINGS_STEP_LABEL = 'Review settings'
export const SETTINGS_STEP_SUBTITLE = 'You can change these later on the integration’s page.'

/** A wizard step, plus the required fields it holds: an empty one brings the person back to it. */
type ChatSetupStep = IntegrationSetupWizardStep & { fields?: string[] }

/** How a new chat integration behaves, chosen during setup. */
export interface ChatSetupBehaviorValue {
  showToolCalls: boolean
  sessionTimeout: number | null
  onlyMentioned: boolean
  answerInThread: boolean
  newSessionPerThread: boolean
}

export const DEFAULT_CHAT_SETUP_BEHAVIOR: ChatSetupBehaviorValue = {
  showToolCalls: false, sessionTimeout: DEFAULT_SESSION_TIMEOUT_HOURS, onlyMentioned: true, answerInThread: true, newSessionPerThread: true,
}

/** Slack's channel behavior, as its stored config spells it. */
export function slackBehaviorConfig(value: ChatSetupBehaviorValue): Record<string, boolean> {
  return {
    ...(value.onlyMentioned ? { onlyMentioned: true } : {}),
    answerInThread: value.answerInThread,
    newSessionPerThread: value.answerInThread && value.newSessionPerThread,
  }
}

export function ChatSetupBehavior({ provider, value, onChange }: {
  provider: ChatProvider
  value: ChatSetupBehaviorValue
  onChange: (value: ChatSetupBehaviorValue) => void
}) {
  const set = (change: Partial<ChatSetupBehaviorValue>) => onChange({ ...value, ...change })
  // One box, a row per setting divided by hairlines, like the email access choices.
  return (
    <div className="divide-y divide-border overflow-hidden rounded-item border">
      <BehaviorRow id="setup-show-tool-calls" label="Show tool calls in chat"
        description="Posts a line for each tool it uses, so you can see it working.">
        <Switch id="setup-show-tool-calls" checked={value.showToolCalls} onCheckedChange={showToolCalls => set({ showToolCalls })} />
      </BehaviorRow>

      <SessionTimeoutSelect
        id="setup-session-timeout"
        layout="setup"
        value={value.sessionTimeout}
        onCommit={sessionTimeout => set({ sessionTimeout })}
      />

      {provider === 'slack' && (
        <>
          <BehaviorRow id="setup-only-mentioned" label="Only respond when @mentioned">
            <Switch id="setup-only-mentioned" checked={value.onlyMentioned} onCheckedChange={onlyMentioned => set({ onlyMentioned })} />
          </BehaviorRow>
          <BehaviorRow id="setup-answer-thread" label="Reply in thread (recommended)"
            description="Replies under the message, not in the channel.">
            <Switch id="setup-answer-thread" checked={value.answerInThread}
              onCheckedChange={(checked) => set({ answerInThread: checked, ...(!checked ? { newSessionPerThread: false } : {}) })} />
          </BehaviorRow>
          {value.answerInThread && (
            <BehaviorRow id="setup-session-per-thread" label="Separate conversation per thread (recommended)"
              description="Each thread stays separate, so requests don’t mix.">
              <Switch id="setup-session-per-thread" checked={value.newSessionPerThread} onCheckedChange={newSessionPerThread => set({ newSessionPerThread })} />
            </BehaviorRow>
          )}
        </>
      )}
    </div>
  )
}

/** One setting in a setup's box: its name on the left, with what it does behind a help icon, and its control on the right. */
function BehaviorRow({ id, label, description, children }: { id: string; label: string; description?: string; children: ReactNode }) {
  return <div className="flex min-h-11 items-center justify-between gap-4 px-3.5 py-2.5">
    <div className="flex min-w-0 items-center gap-1.5">
      <Label htmlFor={id} className="cursor-pointer text-xs font-normal">{label}</Label>
      {description && <IntegrationSetupHelp label={label} testId={`${id}-help`}>{description}</IntegrationSetupHelp>}
    </div>
    {/* The settings cards' switch size, so it sits with 11px text. */}
    <div className="flex shrink-0 [&>button]:origin-right [&>button]:scale-75">{children}</div>
  </div>
}

export function ChatIntegrationSetupForm({
  agentSlug,
  provider,
  onClose,
  leading,
  initial,
}: {
  agentSlug: string
  provider: ChatProvider
  onClose: () => void
  /** Starting values an agent suggested when it handed the setup over. */
  initial?: Record<string, string>
  /** Shown first in the first step, e.g. Slack's choice of webhooks. */
  leading?: ReactNode
}) {
  const createIntegration = useCreateAgentIntegration()
  const testCredentials = useTestAgentIntegrationCredentials()

  const [formData, setFormData] = useState<Record<string, string>>({})
  // No name field: it takes the agent's name (or one an agent suggested), and can be renamed on its page.
  const integrationName = initial?.name ?? ''
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [testResult, setTestResult] = useState<{ valid: boolean; info?: string } | null>(null)
  const [slackSetupMode, setSlackSetupMode] = useState<'manifest' | 'manual'>('manifest')
  const [manifestCopied, setManifestCopied] = useState(false)
  const [manifestPreview, setManifestPreview] = useState(false)
  const { data: agent } = useAgent(provider === 'slack' ? agentSlug : null)
  const slackApp = slackAppIdentity(agent, integrationName)

  const info = PROVIDER_INFO[provider]
  const [step, setStep] = useState(0)
  // Telegram's last step comes after connecting, so the dialog stays open once the bot is connected.
  const [connected, setConnected] = useState(false)

  const field = (key: string, { label, verify, hideLabel }: { label?: string; verify?: boolean; hideLabel?: boolean } = {}) => {
    const spec = info.fields.find(f => f.key === key)
    if (!spec) return null
    return <IntegrationSetupField
      key={spec.key} id={`setup-${spec.key}`} label={label ?? spec.label} hideLabel={hideLabel}
      action={verify && !connected ? verifyAction : undefined}
      type={spec.type} value={formData[spec.key] || ''}
      onChange={e => setFormData({ ...formData, [spec.key]: e.target.value })}
      placeholder={spec.placeholder}
      disabled={connected}
    />
  }

  // Everything the setup works without, in a step of its own before connecting.
  const optionsStep: ChatSetupStep = {
    label: SETTINGS_STEP_LABEL,
    subtitle: SETTINGS_STEP_SUBTITLE,
    content: <>
      <ChatSetupBehavior provider={provider} value={behavior} onChange={setBehavior} />
      {info.fields.some(spec => spec.optional) && <IntegrationSetupAdvanced>
        {info.fields.filter(spec => spec.optional).map(spec => (
          <IntegrationSetupField
            key={spec.key} id={`setup-${spec.key}`} label={spec.label} optional
            type={spec.type} value={formData[spec.key] || ''}
            onChange={e => setFormData({ ...formData, [spec.key]: e.target.value })}
            placeholder={spec.placeholder}
          />
        ))}
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

  const providerSteps: ChatSetupStep[] = provider === 'telegram' ? [
    {
      // Making the bot and pasting its token are one sitting in BotFather's chat, so one step.
      label: 'Create a bot',
      content: <>
        <IntegrationSetupList items={[
          <>In Telegram, open a chat with <IntegrationSetupWizardLink href="https://t.me/BotFather">@BotFather</IntegrationSetupWizardLink>.</>,
          <>Send <IntegrationSetupCode>/newbot</IntegrationSetupCode>.</>,
          'Give the bot a name and a username ending in “bot”.',
          // The last thing done in BotFather's chat, so the last instruction, with its field under it.
          <>Paste the token BotFather sends back.<div className="mt-2">{field('botToken', { label: 'Paste the token BotFather sends back', verify: true, hideLabel: true })}</div></>,
        ]} />
      </>,
      fields: ['botToken'],
    },
    {
      ...optionsStep,
      // Connecting moves on to saying hello; once connected, these steps are only for looking back.
      action: connected ? undefined : connectAction,
    },
    {
      label: 'Say hello',
      subtitle: <>Open your new bot in Telegram and send <IntegrationSetupCode>/start</IntegrationSetupCode> to begin your first conversation with this agent.</>,
      action: { label: 'Done', disabled: !connected, onClick: onClose },
    },
  ] : provider === 'imessage' ? [
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
        {leading}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button" variant="outline" size="sm"
            onClick={async () => {
              await navigator.clipboard.writeText(generateSlackManifest(slackApp))
              setManifestCopied(true)
              setTimeout(() => setManifestCopied(false), 2000)
            }}
          >
            {manifestCopied ? <><Check className="h-3.5 w-3.5" aria-hidden="true" /> Copied</> : <><Copy className="h-3.5 w-3.5" aria-hidden="true" /> Copy manifest</>}
          </Button>
          <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setManifestPreview(!manifestPreview)}>
            {manifestPreview ? <><EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> Hide</> : <><Eye className="h-3.5 w-3.5" aria-hidden="true" /> Preview</>}
          </Button>
        </div>
        {manifestPreview && (
          <pre className="text-2xs leading-relaxed bg-muted/40 border rounded-card p-3 overflow-x-auto max-h-40 select-all">
            {generateSlackManifest(slackApp)}
          </pre>
        )}
        <IntegrationSetupNote>Prefer to add each setting yourself? {modeSwitch('Set up from scratch', 'manual')}</IntegrationSetupNote>
      </>,
    },
    {
      label: 'Create the app',
      subtitle: <>Open Slack’s app page and choose <strong>Create New App → From a manifest</strong>. Pick your workspace, then paste the manifest in place of Slack’s.</>,
      content: <>
        <IntegrationSetupWizardLink href={SLACK_APPS_URL}>Open api.slack.com/apps</IntegrationSetupWizardLink>
        {agent && <SlackAppIconAside agent={agent} />}
      </>,
    },
    appTokenStep,
    botTokenStep,
    optionsStep,
  ] : [
    {
      label: 'Create the app',
      subtitle: <>Open Slack’s app page and choose <strong>Create New App → From scratch</strong>. Name the app and pick your workspace.</>,
      content: <>
        {leading}
        <IntegrationSetupWizardLink href={SLACK_APPS_URL}>Open api.slack.com/apps</IntegrationSetupWizardLink>
        {agent && <SlackAppIconAside agent={agent} withColor />}
        <IntegrationSetupNote>Rather not add each setting yourself? {modeSwitch('Use a manifest instead', 'manifest')}</IntegrationSetupNote>
      </>,
    },
    { label: 'Turn on Socket Mode', subtitle: <>In Slack, go to <strong>Settings → Socket Mode</strong> and turn it on.</> },
    appTokenStep,
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
  const steps = providerSteps

  // Returns an error message string when required fields are missing, else null.
  const validateRequired = (): string | null => {
    const missingRequired = info.fields.some((f) => !f.optional && !formData[f.key]?.trim())
    if (!missingRequired) return null
    if (provider === 'slack') return 'Paste the app token and the bot token first.'
    if (provider === 'telegram') return 'Paste the bot token first.'
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
      const detail = provider === 'telegram'
        ? `Bot: @${result.botUsername || result.botName}`
        : provider === 'slack'
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
        name: integrationName.trim() || undefined,
        config,
        showToolCalls: behavior.showToolCalls,
        sessionTimeout: behavior.sessionTimeout,
      })
      if (provider === 'telegram') { setConnected(true); setTestResult(null); setStep(steps.length - 1) } else onClose()
    } catch {
      // Error surfaced via createIntegration.error
    }
  }

  return (
    <IntegrationSetupWizard
      provider={provider}
      label={info.label}
      heading={provider === 'telegram' ? 'Chat with this agent over Telegram' : undefined}
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
      finish={provider === 'telegram' ? undefined : connectAction}
    />
  )
}
