import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useAgent } from '@renderer/hooks/use-agents'
import { agentIntegrationKeys, useAgentIntegration, useAgentIntegrationSetup, useAgentIntegrationStatus, useAuthorizeAgentIntegration, useCreateAgentIntegration, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { isPublicLinearIntegration, type PublicLinearIntegration } from '@shared/lib/task-manager-integrations/linear/public'
import { useWebhookRelay } from '@renderer/hooks/use-webhook-relay'
import { ToggleRow } from './integration-settings-controls'
import { IntegrationSetupAdvanced, IntegrationSetupField, IntegrationSetupFeedback, IntegrationSetupToggle } from './integration-setup-layout'
import { IntegrationSetupWizardLink, IntegrationSetupWizard, type IntegrationSetupWizardStep } from './integration-setup-wizard'
import type { IntegrationSetupProps } from './setup-types'
import { useIntegrationSetupName } from './use-integration-setup-name'

/** OAuth changes the connection step, while the setup frame remains shared. */
export function LinearSetupForm({ agentSlug, onClose, initial }: IntegrationSetupProps) {
  const { data: agent } = useAgent(agentSlug)
  const name = useIntegrationSetupName(agent?.name || agentSlug, initial?.name, 80)
  const displayName = name.effective
  const setup = useAgentIntegrationSetup(agentSlug, 'linear', displayName || undefined)
  const create = useCreateAgentIntegration()
  const authorization = useAuthorizeAgentIntegration()
  const { open: openLogin, close: closeLogin } = useLoginWindow()
  const [created, setCreated] = useState<PublicAgentIntegration | null>(null)
  const integrationId = created?.id ?? null
  const { data: refreshed, error: refreshError } = useAgentIntegration(integrationId)
  const integration = refreshed ?? created
  const linear = integration && isPublicLinearIntegration(integration) ? integration.linear : undefined
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [credentialsSaved, setCredentialsSaved] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState(0)
  // Linear's form has been opened from here: the step's own button has done its job and gives way to Next.
  const [openedDirectName, setOpenedDirectName] = useState<string | null>(null)
  const connecting = useRef(false)
  const completed = useRef(false)
  const queryClient = useQueryClient()
  const pending = linear?.authorizationState === 'pending' && credentialsSaved
  // Webhooks are offered (and on by default) while the host has a relay:
  // events that happen while the agent is offline are still delivered. The
  // choice is fixed once the account exists.
  const { data: relay } = useWebhookRelay()
  const webhooksOffered = (setup.data?.transports ?? []).includes('relay') && !!relay?.available
  const [webhooksChosen, setWebhooksChosen] = useState(true)
  // The account, once loaded, says; until then the choice made here does.
  const viaRelay = linear ? !!linear.webhook : webhooksOffered && webhooksChosen
  const creationUrl = viaRelay ? linear?.setup.creationUrl : setup.data?.creationUrl

  useEffect(() => {
    if (linear?.authorizationState === 'reconnect_needed') closeLogin()
    if (!linear?.authorized || !integrationId || completed.current) return
    completed.current = true
    void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
    closeLogin()
    onClose()
  }, [linear?.authorizationState, linear?.authorized, integrationId, closeLogin, onClose, agentSlug, queryClient])

  // The app's webhook URL must exist before the app, so with webhooks the
  // first click creates the account (and its URL), then opens Linear's form
  // with it filled in. The tab opens inside the click, before the request, so
  // popup blockers allow it.
  const createAppWithWebhooks = async () => {
    const tab = prepareOAuthPopup()
    setBusy(true); setError(null)
    try {
      const row = await create.mutateAsync({ agentSlug, provider: 'linear', name: displayName, config: { webhooks: true } })
      setCreated(row)
      if (!isPublicLinearIntegration(row)) throw new Error('Could not load the Linear app setup')
      if (openedDirectName !== null) {
        setClientId('')
        setClientSecret('')
      }
      setStep(1)
      await tab.navigate(row.linear.setup.creationUrl)
    } catch (error) {
      tab.close()
      setError(error instanceof Error ? error.message : 'Could not create the webhook URL')
    } finally { setBusy(false) }
  }

  // Without webhooks there is nothing to create first: the button only opens Linear's form.
  const openApp = async () => {
    if (!creationUrl) return
    const tab = prepareOAuthPopup()
    setBusy(true)
    setError(null)
    try {
      await tab.navigate(creationUrl)
      // Keep this app on direct delivery if relay discovery finishes after the click.
      setWebhooksChosen(false)
      setOpenedDirectName(displayName)
      setStep(1)
    } catch (error) {
      tab.close()
      setError(error instanceof Error ? error.message : 'Could not open Linear')
    } finally { setBusy(false) }
  }

  const keysMissing = !credentialsSaved && (!clientId.trim() || !clientSecret.trim())
  const connect = async () => {
    if (connecting.current) return
    // With webhooks the keys are a step back from Connect, and the app a step before that: say what's missing where it is.
    if (viaRelay && !integrationId) { setError('Create the app in Linear first.'); setStep(0); return }
    if (keysMissing) { setError('Paste the Client ID and Client secret first.'); setStep(1); return }
    connecting.current = true
    setBusy(true); setError(null); setAuthUrl(null)
    try {
      await openLogin(async () => {
        // Keep the created ID on failure so retries authorize the same account.
        let id = integrationId
        if (!id) {
          const row = await create.mutateAsync({ agentSlug, provider: 'linear', name: displayName, config: {} })
          id = row.id
          setCreated(row)
        }
        const result = await authorization.mutateAsync({ id, agentSlug, config: credentialsSaved ? {} : { clientId, clientSecret, ...(viaRelay && webhookSecret.trim() ? { webhookSecret } : {}) } })
        setClientSecret(''); setWebhookSecret(''); setCredentialsSaved(true); setAuthUrl(result.url)
        return result.url
      })
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not connect integration') }
    finally { connecting.current = false; setBusy(false) }
  }

  const appOpened = !!integrationId || (!viaRelay && openedDirectName === displayName)
  // What Connect does, beside it: the last step is about what to paste. Broken by hand, so it doesn't re-wrap
  // when the button grows its arrow on hover.
  const connectNote = credentialsSaved ? undefined : <>Connect opens Linear, where you{' '}<br />choose its workspace and teams.</>
  const keys: IntegrationSetupWizardStep = {
    label: 'Paste the keys',
    subtitle: <>In Linear, open the app’s page and copy the <strong>Client ID</strong> and <strong>Client secret</strong>.</>,
    content: <>
      <IntegrationSetupField id="linear-client-id" label="Client ID" placeholder="Paste Client ID" value={clientId} onChange={event => { setClientId(event.target.value); setError(null) }} autoComplete="off" disabled={busy || credentialsSaved} />
      <IntegrationSetupField id="linear-client-secret" label="Client secret" type="password" value={clientSecret} onChange={event => { setClientSecret(event.target.value); setError(null) }} autoComplete="new-password" placeholder={credentialsSaved ? 'Saved securely' : 'Paste Client secret'} disabled={busy || credentialsSaved} />
    </>,
    note: viaRelay ? undefined : connectNote,
  }
  // Its own step: it comes from another part of the app's page, and it is the one key that can be left out.
  const signingSecret: IntegrationSetupWizardStep = {
    label: 'Add the signing secret',
    subtitle: <>On the same page, copy the webhook <strong>Signing secret</strong>. It lets this agent check that events really come from Linear.</>,
    content: <IntegrationSetupField id="linear-webhook-secret" label="Webhook signing secret" type="password" value={webhookSecret} onChange={event => setWebhookSecret(event.target.value)} autoComplete="new-password"
      placeholder={credentialsSaved ? 'Saved securely' : 'Paste signing secret'} disabled={busy || credentialsSaved}
      hint="Strongly recommended. Without it, events aren’t verified." />,
    note: connectNote,
  }

  return <IntegrationSetupWizard provider="linear" label="Linear"
    description="Assign this agent issues, or mention it in comments."
    step={step} onStepChange={setStep}
    steps={[
      {
        label: 'Create the app',
        subtitle: <><strong>Create app in Linear</strong> opens Linear with the app’s settings filled in. Leave them as they are and create the app.</>,
        content: <>
          <IntegrationSetupField id="linear-app-name" label="App name" {...name.input} disabled={busy || !!integrationId} />
          {appOpened && creationUrl && <div><IntegrationSetupWizardLink variant="button" href={creationUrl}>Create app in Linear</IntegrationSetupWizardLink></div>}
          {(webhooksOffered || setup.data?.redirectUri) && <IntegrationSetupAdvanced flush>
            {/* It decides how the app is created, so it is fixed once the account exists. */}
            {webhooksOffered && <IntegrationSetupToggle id="linear-webhooks-choice" testId="linear-webhooks-choice" label="Use webhooks (recommended)"
              description="Events that happen while this agent is offline arrive when it’s back. Without webhooks it uses a live connection and misses them."
              checked={viaRelay} onCheckedChange={setWebhooksChosen} disabled={busy || !!integrationId} />}
            {setup.data?.redirectUri && <div className="text-muted-foreground">Callback URL<p className="mt-1 break-all select-all text-foreground" data-testid="linear-setup-callback-url">{setup.data.redirectUri}</p></div>}
          </IntegrationSetupAdvanced>}
        </>,
        // The first click opens Linear (creating the account first, with webhooks); after that it's an ordinary Next.
        action: appOpened ? undefined : {
          label: 'Create app in Linear', busy, disabled: !displayName || !setup.data || (!viaRelay && !creationUrl), external: true, testId: 'linear-create-app',
          onClick: () => void (viaRelay ? createAppWithWebhooks() : openApp()),
        },
      },
      keys,
      ...(viaRelay ? [signingSecret] : []),
    ]}
    feedback={(setup.error || error || linear?.authorizationMessage || refreshError || pending) && <>
      {setup.error && <IntegrationSetupFeedback state="error">{setup.error.message} <button className="underline" onClick={() => void setup.refetch()}>Try again</button></IntegrationSetupFeedback>}
      {(error || linear?.authorizationMessage || refreshError) && <IntegrationSetupFeedback state="error">{error ?? linear?.authorizationMessage ?? 'Could not check authorization. Reopen this integration to continue.'}</IntegrationSetupFeedback>}
      {pending && <IntegrationSetupFeedback state="pending">
        <p>Approve access in Linear. This window updates when you’re done.</p>
        {authUrl && <a href={authUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block underline" onClick={event => {
          if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(authUrl) }
        }}>Open Linear again</a>}
      </IntegrationSetupFeedback>}
    </>}
    aside={credentialsSaved ? { label: 'Edit keys', disabled: busy, onClick: () => { closeLogin(); setCredentialsSaved(false); setAuthUrl(null); setError(null) } } : undefined}
    finish={{
      label: pending ? 'Start again' : 'Connect', busyLabel: 'Connecting…', busy, external: true,
      // Where the keys are on the same screen, the button waits for them; a step away, it says what's missing instead.
      disabled: !displayName || !setup.data || (!viaRelay && keysMissing),
      onClick: () => void connect(),
    }}
  />
}

/** Only credentials differ by provider; lifecycle, settings and history stay shared. */
export function LinearConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [editCredentials, setEditCredentials] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const authorization = useAuthorizeAgentIntegration()
  const { open: openLogin, close: closeLogin } = useLoginWindow()
  const connected = isPublicLinearIntegration(integration) && integration.linear.authorized
  useEffect(() => { if (connected) closeLogin() }, [connected, closeLogin])
  if (!isPublicLinearIntegration(integration)) return null
  const linear = integration.linear
  const needsCredentials = !linear.canReconnect || editCredentials
  // A relay installation can't authorize without it (e.g. setup stopped after the webhook URL).
  const needsWebhookSecret = needsCredentials && !!linear.webhook && !linear.webhook.secretSaved
  const pending = linear.authorizationState === 'pending'
  const authorize = async (useSaved = false) => {
    setBusy(true); setError(null); setAuthUrl(null)
    try {
      await openLogin(async () => {
        const result = await authorization.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, config: useSaved ? {} : { clientId, clientSecret, ...(needsWebhookSecret && webhookSecret.trim() ? { webhookSecret } : {}) } })
        setClientSecret(''); setWebhookSecret(''); setEditCredentials(false); setAuthUrl(result.url)
        return result.url
      })
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not authorize integration') }
    finally { setBusy(false) }
  }
  return <DetailCard label="Linear Account">
    <div className="space-y-4">
      {linear.identity && <div><p className="text-sm font-medium">{linear.identity.appName}</p><p className="text-xs text-muted-foreground">{linear.identity.workspaceName}</p></div>}
      {linear.authorizationMessage && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">{linear.authorizationMessage}</p>}
      {needsCredentials && <>
        <div className="space-y-2"><p className="text-sm font-medium">1. Create your agent’s app</p>
          <p className="text-xs text-muted-foreground">Use the prefilled form, add an avatar, keep the app private, and {linear.webhook ? 'keep webhooks on' : 'leave webhooks off'}. To reconnect, use the existing app.</p>
          <IntegrationSetupWizardLink variant="button" href={linear.setup.creationUrl}>Create app in Linear</IntegrationSetupWizardLink>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Callback URL</summary><p className="mt-2 break-all">{linear.setup.redirectUri}</p></details>
        </div>
        <div className="space-y-3"><p className="text-sm font-medium">2. Copy the app credentials</p>
          <div className="space-y-1"><Label htmlFor="linear-client-id">Client ID</Label><Input id="linear-client-id" autoComplete="off" value={clientId} onChange={event => { setClientId(event.target.value); setAuthUrl(null) }} /></div>
          <div className="space-y-1"><Label htmlFor="linear-client-secret">Client secret</Label><Input id="linear-client-secret" type="password" autoComplete="new-password" value={clientSecret} onChange={event => { setClientSecret(event.target.value); setAuthUrl(null) }} /></div>
          {needsWebhookSecret && <div className="space-y-1"><Label htmlFor="linear-reconnect-webhook-secret">Webhook signing secret (strongly recommended)</Label><Input id="linear-reconnect-webhook-secret" type="password" autoComplete="new-password" value={webhookSecret} onChange={event => { setWebhookSecret(event.target.value); setAuthUrl(null) }} /></div>}
        </div>
      </>}
      <div className="space-y-2">
        {needsCredentials && <><p className="text-sm font-medium">3. Authorize this agent</p>
          <p className="text-xs text-muted-foreground">Choose the workspace and teams this agent can access. Allow it to read, edit, receive mentions and receive delegated issues.</p></>}
        {pending && !editCredentials && <>
          {authUrl && <IntegrationSetupWizardLink variant="button" href={authUrl}>Authorize in Linear</IntegrationSetupWizardLink>}
          <p className="text-xs text-muted-foreground">Waiting for authorization. This page updates automatically.</p>
        </>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={needsCredentials ? 'default' : 'outline'} disabled={busy || (needsCredentials && (!clientId.trim() || !clientSecret.trim()))} onClick={() => void authorize(!needsCredentials)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}{needsCredentials ? 'Continue to authorization' : pending ? 'Start again' : 'Reconnect account'}
          </Button>
          {linear.canReconnect && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditCredentials(!editCredentials); setAuthUrl(null); setError(null) }}>{editCredentials ? 'Cancel' : 'Edit app credentials'}</Button>}
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}

export function LinearIntegrationSettings({ integration }: { integration: PublicAgentIntegration }) {
  const update = useUpdateAgentIntegration()
  if (!isPublicLinearIntegration(integration)) return null
  return <>
    <DetailCard label="Integration Settings"><ToggleRow
      label="Run on status changes" helperText="Start work when an involved issue changes status."
      checked={integration.settings.runOnStatusChange} disabled={update.isPending}
      onCheckedChange={runOnStatusChange => update.mutate({ id: integration.id, settings: { runOnStatusChange } })}
    /></DetailCard>
    <LinearDeliverySettings integration={integration} />
  </>
}

/** What Linear's app settings call each webhook resource type. */
const LINEAR_EVENT_LABELS: Record<string, string> = { AppUserNotification: 'Inbox notifications', Comment: 'Comments', Issue: 'Issues' }

/** Why this integration won't use its webhooks when it next connects, or null if it will. */
function webhookFallbackReason(webhook: NonNullable<PublicLinearIntegration['linear']['webhook']>, relayAvailable: boolean): string | null {
  if (webhook.secretRejected) return 'Linear’s deliveries don’t match the saved signing secret'
  if (!relayAvailable) return 'the webhook relay is unavailable'
  return null
}

/**
 * Which path brings Linear's events in. It is chosen each time the integration
 * connects: webhooks when they're set up and usable, the live connection
 * otherwise. Setting webhooks up or removing them is explicit, since the
 * Linear app's settings change with them.
 */
function LinearDeliverySettings({ integration }: { integration: PublicLinearIntegration }) {
  const update = useUpdateAgentIntegration()
  const { data: relay } = useWebhookRelay()
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { data: connection } = useAgentIntegrationStatus(integration.id)
  const { webhook } = integration.linear
  const fallback = webhook ? webhookFallbackReason(webhook, !!relay?.available) : null
  // What runs now is the connection's own report; the next connect may differ.
  const running = connection?.transport ?? null
  const next = webhook && !fallback ? 'relay' : 'direct'
  const save = (settings: Record<string, unknown>) => {
    setError(null)
    update.mutate({ id: integration.id, settings }, {
      onSuccess: () => setSecret(''),
      onError: failure => setError(failure.message),
    })
  }
  return <DetailCard label="Event Delivery">
    <div className="space-y-3">
      <p className="text-sm" data-testid="linear-delivery-path">{running === 'relay'
        ? 'Through webhooks. Events that happen while this agent is offline are delivered when it’s back.'
        : running === 'direct'
          ? 'Over a live connection. Events that happen while it’s disconnected are missed.'
          : `Not connected. It will use ${next === 'relay' ? 'webhooks' : 'a live connection'} when it connects.`}</p>
      {running && running !== next && <p role="status" className="text-xs text-muted-foreground" data-testid="linear-delivery-next">
        {next === 'relay'
          ? 'Webhooks are ready; it switches to them the next time it connects.'
          : `It switches to a live connection the next time it connects: ${fallback ?? 'webhooks aren’t set up'}.`}
      </p>}
      {running !== 'relay' && next === 'direct' && fallback && <p role="status" className="text-xs text-muted-foreground" data-testid="linear-delivery-reason">Not using webhooks: {fallback}.</p>}
      {webhook && <>
        <div className="space-y-1 text-xs">
          <p className="text-muted-foreground">In this agent’s Linear app, turn webhooks on with this URL and these events: {webhook.resourceTypes.map(type => LINEAR_EVENT_LABELS[type] ?? type).join(', ')}.</p>
          <p className="break-all select-all font-mono" data-testid="linear-webhook-url">{webhook.url}</p>
        </div>
        {!webhook.secretSaved && <p role="alert" className="text-xs text-amber-700 dark:text-amber-400" data-testid="linear-secret-missing">
          Strongly recommended: paste the app’s webhook signing secret. Without it, deliveries aren’t verified: each is read back from Linear, but anyone who learns this URL could make the agent act on real Linear items it would otherwise have skipped.
        </p>}
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="linear-webhook-secret-update">Webhook signing secret</Label>
            <Input id="linear-webhook-secret-update" type="password" autoComplete="new-password" value={secret} placeholder={webhook.secretSaved ? 'Saved securely' : undefined} onChange={event => setSecret(event.target.value)} />
          </div>
          <Button size="sm" disabled={update.isPending || !secret.trim()} onClick={() => save({ webhookSecret: secret.trim() })}>Save</Button>
        </div>
        <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => save({ webhooks: false })}>Remove webhooks</Button>
      </>}
      {!webhook && relay?.available && <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => save({ webhooks: true })}>Set up webhooks</Button>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  </DetailCard>
}
