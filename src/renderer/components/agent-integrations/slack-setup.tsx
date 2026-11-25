import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { DialogTitle } from '@renderer/components/ui/dialog'
import { agentIntegrationKeys, useAgentIntegrationSetup, useCreateAgentIntegration, useTestAgentIntegrationCredentials, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useAgent } from '@renderer/hooks/use-agents'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { publicSlackDelivery } from '@shared/lib/chat-integrations/public'
import { slackAppCreationUrl } from '@shared/lib/chat-integrations/slack-manifest'
import type { IntegrationSetupMetadata } from '@shared/lib/agent-integrations/setup-schema'
import { ChatSetupSteps } from './chat-integration-setup-form'
import { ChatSetupBehavior, DEFAULT_CHAT_SETUP_BEHAVIOR, SETTINGS_STEP_LABEL, SETTINGS_STEP_SUBTITLE, slackBehaviorConfig } from './chat-setup-behavior'
import { IntegrationSetupAdvanced, IntegrationSetupFeedback, IntegrationSetupField, IntegrationSetupNote, IntegrationSetupToggle } from './integration-setup-layout'
import { IntegrationSetupWizardLink, IntegrationSetupWizard } from './integration-setup-wizard'
import type { IntegrationSetupProps } from './setup-types'
import { SlackAppIconAside, slackAppIconStep } from './slack-app-appearance'
import { DEFAULT_SLACK_APP_NAME, slackAppIdentity, type SlackAppAgent } from './slack-app-identity'
import { SlackProvisionedSetupForm } from './slack-provisioned-setup'
import { useIntegrationSetupName, type IntegrationSetupName } from './use-integration-setup-name'

/**
 * Slack's setup. With the host's webhook relay, the app posts to the agent's
 * webhook URL (recommended): messages sent while the agent is offline wait for
 * it. Otherwise, or by choice, the app uses Socket Mode.
 */
export function SlackSetup(props: IntegrationSetupProps) {
  const { data: relay, isPending } = useWebhookRelay()
  // A connected team directory that can create the app (Settings → Team Directory).
  const setup = useAgentIntegrationSetup(props.agentSlug, 'slack')
  const { data: agent, isPending: agentPending } = useAgent(props.agentSlug)
  const name = useIntegrationSetupName(agent?.name || DEFAULT_SLACK_APP_NAME, props.initial?.name, 35)
  // "Set up manually" on the one-click step: the app is made by hand instead.
  const [manual, setManual] = useState(false)
  const [webhooks, setWebhooks] = useState(true)
  // Once its installation exists, the Slack app targets that webhook: the form
  // stays, whatever the relay does meanwhile.
  const [webhookCreated, setWebhookCreated] = useState(false)
  const [createdIn, setCreatedIn] = useState<IntegrationSetupMetadata['provisioning']>()
  // Which form depends on the relay; one that can't be read means Socket Mode.
  if (isPending || setup.isPending || agentPending) return <>
    <DialogTitle className="sr-only">Connect Slack</DialogTitle>
    <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" /></div>
  </>
  const choice = (disabled = false) => relay?.available && <IntegrationSetupToggle id="slack-webhooks-choice" testId="slack-webhooks-choice" label="Use webhooks (recommended)"
    description="Messages sent while this agent is offline arrive when it’s back. Without webhooks it uses Socket Mode and misses them."
    checked={webhooks} onCheckedChange={setWebhooks} disabled={disabled} />
  // Created apps receive through webhooks, so they need the relay.
  const provisioning = createdIn ?? (!manual && !webhookCreated && relay?.available ? setup.data?.provisioning : undefined)
  if (provisioning) {
    return <SlackProvisionedSetupForm {...props} agent={agent} name={name} provisioning={provisioning}
      onCreated={() => setCreatedIn(provisioning)} onManual={() => setManual(true)} />
  }
  // A directory could create the app, but this host can't receive its events: say why the setup is by hand.
  const noRelay = relay && !relay.available && setup.data?.provisioning && (
    <p className="rounded-item border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="slack-provisioning-needs-relay">
      One-click setup through {setup.data.provisioning.workspace} needs a webhook relay, which you get by connecting your Gamut account. Until then, set the app up manually.
    </p>
  )
  return webhookCreated || (relay?.available && webhooks)
    ? <SlackWebhookSetupForm {...props} agent={agent} name={name} choice={choice} onCreated={() => setWebhookCreated(true)} />
    // Unticking webhooks swaps the form; the choice sits in both first steps, so it can be ticked again.
    : <ChatSetupSteps {...props} provider="slack" agent={agent} name={name} leading={<>{noRelay}{choice()}</>} />
}

/** Slack sometimes lists the request URL as unverified; worth knowing only if it does. */
const UNVERIFIED_HINT = 'If Slack lists the request URL as unverified, open App Manifest and click Verify.'

/**
 * The installation comes first, so the app can be created with its webhook
 * URL; it waits, disconnected, for the app's signing secret and bot token.
 */
function SlackWebhookSetupForm({ agentSlug, onClose, choice, onCreated, agent, name }: IntegrationSetupProps & {
  agent: SlackAppAgent | undefined; name: IntegrationSetupName
  choice: (disabled?: boolean) => ReactNode; onCreated: () => void
}) {
  const create = useCreateAgentIntegration()
  const finish = useUpdateAgentIntegration()
  const testCredentials = useTestAgentIntegrationCredentials()
  const queryClient = useQueryClient()
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [created, setCreated] = useState<{ id: string; webhookUrl: string } | null>(null)
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [feedback, setFeedback] = useState<{ valid: boolean; info: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(0)
  const app = slackAppIdentity(agent, name.effective)
  const webhooksChoice = choice(busy || !!created)
  const iconStep = slackAppIconStep(agent, { name: app.name })

  // The URL must exist before the app, so the first click creates the
  // installation, then opens Slack with it filled in. The tab opens inside
  // the click, before the request, so popup blockers allow it.
  const createApp = async () => {
    const tab = prepareOAuthPopup()
    setBusy(true); setFeedback(null)
    try {
      const row = await create.mutateAsync({ agentSlug, provider: 'slack', name: name.override,
        config: { webhooks: true, ...slackBehaviorConfig(behavior) }, showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout })
      const webhookUrl = publicSlackDelivery(row)?.webhook?.url
      if (!webhookUrl) throw new Error('Could not create the webhook URL')
      setCreated({ id: row.id, webhookUrl })
      onCreated()
      setStep(1)
      await tab.navigate(slackAppCreationUrl(app, webhookUrl))
    } catch (error) {
      tab.close()
      setFeedback({ valid: false, info: error instanceof Error ? error.message : 'Could not create the webhook URL' })
    } finally { setBusy(false) }
  }

  const verify = async () => {
    setFeedback(null)
    try {
      const result = await testCredentials.mutateAsync({ provider: 'slack', config: { botToken: botToken.trim() } })
      setFeedback({ valid: true, info: `Workspace: ${result.team}` })
    } catch (error) {
      setFeedback({ valid: false, info: error instanceof Error ? error.message : 'Invalid bot token' })
    }
  }

  const connect = async () => {
    if (!created) return
    setBusy(true); setFeedback(null)
    try {
      await finish.mutateAsync({ id: created.id, status: 'active', showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout,
        config: { botToken: botToken.trim(), signingSecret: signingSecret.trim(), ...slackBehaviorConfig(behavior) } })
      void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
      onClose()
    } catch (error) {
      setFeedback({ valid: false, info: error instanceof Error ? error.message : 'Could not connect Slack' })
    } finally { setBusy(false) }
  }

  return <IntegrationSetupWizard provider="slack" label="Slack"
    description="DM this agent in Slack, or mention it in channels."
    step={step} onStepChange={setStep}
    steps={[
      {
        label: 'Create the app',
        subtitle: <><strong>Create app in Slack</strong> opens Slack with the app’s settings filled in. Pick your workspace and create the app.</>,
        content: <>
          <IntegrationSetupField id="setup-integration-name" label="App name" {...name.input} disabled={busy || !!created} />
          {created && <div><IntegrationSetupWizardLink variant="button" href={slackAppCreationUrl(app, created.webhookUrl)}>Create app in Slack</IntegrationSetupWizardLink></div>}
          {created && <IntegrationSetupNote>{UNVERIFIED_HINT}</IntegrationSetupNote>}
          <IntegrationSetupAdvanced flush>
            {webhooksChoice}
            {created && <div className="text-muted-foreground">Webhook URL<p className="mt-1 break-all select-all text-foreground" data-testid="slack-setup-webhook-url">{created.webhookUrl}</p></div>}
          </IntegrationSetupAdvanced>
        </>,
        // The first click creates the installation and opens Slack; after that it's an ordinary Next.
        action: created ? undefined : { label: 'Create app in Slack', busy, onClick: () => void createApp(), testId: 'slack-create-app', external: true },
      },
      {
        label: 'Paste the secret',
        // Until the app exists there is nothing to copy, so the instruction starts there.
        subtitle: created
          ? <>In Slack, go to <strong>Basic Information → App Credentials</strong> and copy the <strong>Signing Secret</strong>.</>
          : <>Once you’ve created the app, go to <strong>Basic Information → App Credentials</strong> in Slack and copy the <strong>Signing Secret</strong>.</>,
        content: <IntegrationSetupField id="setup-signingSecret" label="Signing Secret" type="password" autoComplete="new-password" value={signingSecret}
          onChange={event => setSigningSecret(event.target.value)} placeholder="Paste signing secret" disabled={!created} />,
      },
      // Uploaded on the page the Signing Secret is copied from, so it comes while they're on it.
      ...(iconStep ? [iconStep] : []),
      {
        label: 'Paste the bot token',
        // It follows the Signing Secret, which has already said the app comes first.
        subtitle: <>Now, go to <strong>Install App</strong> in Slack and install the app to your workspace. Then copy the <strong>Bot User OAuth Token</strong> (xoxb-…).</>,
        content: <>
          <IntegrationSetupField id="setup-botToken" label="Bot Token" type="password" autoComplete="new-password" value={botToken}
            onChange={event => setBotToken(event.target.value)} placeholder="xoxb-…" disabled={!created}
            action={created ? { label: 'Verify', busyLabel: 'Verifying…', busy: testCredentials.isPending, disabled: !botToken.trim(), onClick: () => void verify() } : undefined} />
        </>,
      },
      {
        // Sent with Connect, so they can still change after the app is created.
        label: SETTINGS_STEP_LABEL,
        subtitle: SETTINGS_STEP_SUBTITLE,
        content: <ChatSetupBehavior provider="slack" value={behavior} onChange={setBehavior} disabled={busy} />,
      },
    ]}
    feedback={feedback && <IntegrationSetupFeedback state={feedback.valid ? 'success' : 'error'}>{feedback.info}</IntegrationSetupFeedback>}
    finish={{ label: 'Connect', busyLabel: 'Connecting…', busy: busy && !!created, disabled: busy || !created || !botToken.trim() || !signingSecret.trim(), onClick: () => void connect() }}
  />
}

/**
 * An installation set up with webhooks whose Slack app isn't connected yet,
 * e.g. setup stopped after the app was created: the rest of its steps.
 */
export function SlackConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const slack = publicSlackDelivery(integration)
  const update = useUpdateAgentIntegration()
  const [signingSecret, setSigningSecret] = useState('')
  const [botToken, setBotToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { data: agent } = useAgent(integration.agentSlug)
  // An app a team directory created installs from its own card.
  if (!slack || slack.botTokenSaved || !slack.webhook || integration.provisionedApp) return null
  const creationUrl = slackAppCreationUrl(slackAppIdentity(agent, integration.name), slack.webhook.url)
  const connect = () => {
    setError(null)
    update.mutate({ id: integration.id, status: 'active', config: { botToken: botToken.trim(), signingSecret: signingSecret.trim() } }, {
      onSuccess: () => { setBotToken(''); setSigningSecret('') },
      onError: failure => setError(failure.message),
    })
  }
  return <DetailCard label="Slack App">
    <div className="space-y-3" data-testid="slack-finish-setup">
      <p className="text-sm">Finish setting up this agent’s Slack app.</p>
      <ol className="list-decimal list-outside ml-5 space-y-1.5 text-xs text-muted-foreground">
        <li>Create the app in Slack. Its settings are already filled in for this agent: pick your workspace and create it.
          <div className="mt-2"><IntegrationSetupWizardLink variant="button" href={creationUrl}>Create app in Slack</IntegrationSetupWizardLink></div>
        </li>
        <li>In <strong className="font-medium">Basic Information → App Credentials</strong>, copy the <strong className="font-medium">Signing Secret</strong> and paste it here.</li>
        <li>In <strong className="font-medium">Install App</strong>, install it to your workspace. Paste its <strong className="font-medium">Bot User OAuth Token</strong> (xoxb-…) here, then click Connect.</li>
      </ol>
      {agent && <SlackAppIconAside agent={agent} />}
      <p className="text-xs text-muted-foreground">{UNVERIFIED_HINT}</p>
      <IntegrationSetupField id="slack-finish-signing-secret" label="Signing Secret" type="password" autoComplete="new-password" value={signingSecret} onChange={event => setSigningSecret(event.target.value)} placeholder="Paste signing secret" />
      <IntegrationSetupField id="slack-finish-bot-token" label="Bot Token" type="password" autoComplete="new-password" value={botToken} onChange={event => setBotToken(event.target.value)} placeholder="xoxb-…" />
      <Button size="sm" disabled={update.isPending || !botToken.trim() || !signingSecret.trim()} onClick={connect}>
        {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Connect
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}
