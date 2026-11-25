import { useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Download, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentIntegrationSetup, useCreateAgentIntegration, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { saveBlob } from '@renderer/lib/download'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { teamsIdentitySchema, type TeamsConfig } from '@shared/lib/chat-integrations/config-schema'
import { publicTeamsDelivery } from '@shared/lib/chat-integrations/public'
import { IntegrationSetupChoices, IntegrationSetupFeedback, IntegrationSetupField, IntegrationSetupList, IntegrationSetupNote } from './integration-setup-layout'
import { IntegrationSetupWizard, IntegrationSetupWizardLink } from './integration-setup-wizard'
import { useIntegrationSetupName } from './use-integration-setup-name'
import { CopyTextButton } from './slack-delivery-card'
import { teamsAppPackage, type TeamsPackageAgent } from './teams-app-package'
import type { IntegrationSetupProps } from './setup-types'

const appIdSchema = teamsIdentitySchema.shape.appId
const ENTRA_URL = 'https://entra.microsoft.com/'
const DEV_PORTAL_URL = 'https://dev.teams.microsoft.com/bots'
const TEAMS_URL = 'https://teams.microsoft.com/'
const TEAMS_ADMIN_URL = 'https://admin.teams.microsoft.com/policies/manage-apps'
type DeliveryMode = TeamsConfig['deliveryMode']

function Endpoint({ url }: { url: string }) {
  return <div className="space-y-1.5">
    <p className="text-xs font-medium">Messaging endpoint</p>
    <p className="select-all break-all rounded-item border bg-background px-2 py-1.5 font-mono text-xs" data-testid="teams-messaging-endpoint">{url}</p>
    <CopyTextButton text={url} label="Copy endpoint" />
  </div>
}

function PackageDownload({ agent, appId, name, canUpdate }: {
  agent?: TeamsPackageAgent; appId: string; name: string; canUpdate?: boolean
}) {
  const versionId = useId()
  const [version, setVersion] = useState('1.0.0')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const download = async () => {
    if (!agent || busy) return
    setError('')
    setBusy(true)
    try {
      const blob = await teamsAppPackage(agent, appId, name, version)
      saveBlob(blob, `${agent.slug}-teams.zip`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the Teams app package')
    } finally { setBusy(false) }
  }
  return <div className="space-y-2">
    {agent && <div className="flex items-center gap-2">
      {agent.avatar && <AgentAvatar agent={agent} size={32} still />}
      <div className="min-w-0"><p className="truncate text-sm font-medium">{name}</p><p className="text-xs text-muted-foreground">Microsoft Teams app package</p></div>
    </div>}
    {canUpdate && <div className="max-w-72 space-y-1">
      <IntegrationSetupField id={versionId} label="Package version" value={version} onChange={event => setVersion(event.target.value)} />
      <p className="text-xs text-muted-foreground">Increase the version to update an installed app’s name or icon.</p>
    </div>}
    <Button type="button" variant="outline" size="sm" disabled={!agent || !appIdSchema.safeParse(appId).success || !name.trim() || busy} onClick={download}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download app package
    </Button>
    {error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
  </div>
}

function ConfigureBot({ mode }: { mode: DeliveryMode }) {
  return <>In the <IntegrationSetupWizardLink href={DEV_PORTAL_URL}>Teams Developer Portal</IntegrationSetupWizardLink>, select your bot and open <strong>Configure → Delivery method</strong>. {mode === 'socket'
    ? <>Select <strong>Socket mode</strong> and save.</>
    : <>Select <strong>HTTPS endpoint</strong>, paste the messaging endpoint, and save.</>}</>
}

function InstallInstructions() {
  return <div className="space-y-4">
    <IntegrationSetupList items={[
      <>In <IntegrationSetupWizardLink href={TEAMS_URL}>Teams</IntegrationSetupWizardLink>, open <strong>Apps → Manage your apps → More options → Upload an app → Upload a custom app</strong>. Select the ZIP and add the agent to a chat or team.</>,
      <>If your organization manages uploads, an admin can upload the same ZIP under <strong>Teams apps → Manage apps → Upload new app</strong> in the <IntegrationSetupWizardLink href={TEAMS_ADMIN_URL}>Teams admin center</IntegrationSetupWizardLink>.</>,
      <>Send the agent a personal message to start chatting. In channels and group chats, @mention the agent on each message, including replies.</>,
    ]} />
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer">Private channels, shared channels, and files</summary>
      <p className="pt-2">Add the app to the host team and then to the channel. Channel members can @mention the agent there. Channel file links require access in Gamut. Use personal chat in the registered tenant for file transfers.</p>
    </details>
  </div>
}

export function TeamsSetup({ agentSlug, initial, onClose, onIntegrationCreated }: IntegrationSetupProps) {
  const navigate = useNavigate()
  const { data: agent } = useAgent(agentSlug)
  const setup = useAgentIntegrationSetup(agentSlug, 'teams')
  const create = useCreateAgentIntegration()
  const [saved, setSaved] = useState<PublicAgentIntegration | null>(null)
  const name = useIntegrationSetupName(agent?.name || 'Gamut agent', initial?.name, 100)
  const [step, setStep] = useState(0)
  const [tenantId, setTenantId] = useState('')
  const [appId, setAppId] = useState('')
  const [clientSecret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<DeliveryMode>('https')
  const parsedAppId = appIdSchema.safeParse(appId).data
  const delivery = saved ? publicTeamsDelivery(saved) : undefined
  const httpsUnavailable = setup.data?.teamsRelayAvailable === false && !setup.data.teamsMessagingBaseUrl
  const endpoint = delivery?.messagingEndpoint || (setup.data?.teamsMessagingBaseUrl && parsedAppId ? `${setup.data.teamsMessagingBaseUrl}/${parsedAppId}` : undefined)
  const locked = !!saved || create.isPending

  const save = async () => {
    if (locked) return
    setError('')
    const identity = teamsIdentitySchema.safeParse({ tenantId, appId })
    if (!identity.success) {
      setStep(parsedAppId ? 1 : 0)
      setError('Enter the directory and application IDs from the app registration as UUIDs.')
      return
    }
    if (!clientSecret.trim()) {
      setStep(1)
      setError('Enter the client secret value.')
      return
    }
    try {
      const row = await create.mutateAsync({ agentSlug, provider: 'teams', name: name.override,
        config: { ...identity.data, clientSecret: clientSecret.trim(), deliveryMode: mode } })
      setSecret('')
      setSaved(row)
      setStep(3)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save Teams credentials')
    }
  }

  const finish = () => {
    if (!saved) return
    onClose()
    if (onIntegrationCreated) onIntegrationCreated(saved.id)
    else void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: saved.id } })
  }

  return <IntegrationSetupWizard provider="teams" label="Microsoft Teams" description="Message this agent in Teams or mention it in channels."
    step={step} onStepChange={next => { if (!create.isPending) { setStep(next); setError('') } }} complete={!!saved}
    feedback={error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    steps={[
      {
        label: 'Create the bot',
        lead: <IntegrationSetupField id="teams-name" label="App name in Teams" {...name.input} disabled={locked} />,
        subtitle: <>In the <IntegrationSetupWizardLink href={DEV_PORTAL_URL}>Teams Developer Portal</IntegrationSetupWizardLink>, open <strong>Tools → Bot management → New bot</strong>. Enter the app name and copy its <strong>Bot ID</strong>.</>,
        content: <>
          <IntegrationSetupField id="teams-app-id" label="Application (client) ID" value={appId} onChange={event => setAppId(event.target.value)} autoComplete="off" spellCheck={false} disabled={locked} />
          {parsedAppId && !saved && <PackageDownload agent={agent} appId={parsedAppId} name={name.effective} />}
        </>,
      },
      {
        label: 'Enter credentials',
        subtitle: <>In the <IntegrationSetupWizardLink href={ENTRA_URL}>Microsoft Entra admin center</IntegrationSetupWizardLink>, open <strong>Entra ID → Overview</strong> and copy the tenant ID. In the bot’s <strong>Client secrets</strong> in Teams Developer Portal, add a secret and copy its value.</>,
        content: <>
          <IntegrationSetupField id="teams-tenant-id" label="Directory (tenant) ID" value={tenantId} onChange={event => setTenantId(event.target.value)} autoComplete="off" spellCheck={false} disabled={locked} />
          <IntegrationSetupField id="teams-client-secret" label="Client secret value" type="password" value={clientSecret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" disabled={locked} />
        </>,
      },
      {
        label: 'Choose delivery',
        subtitle: <>Choose how Teams delivers messages to the agent.</>,
        content: <>
          <IntegrationSetupChoices<DeliveryMode> label="Delivery method" value={mode} onChange={setMode} disabled={locked}
            options={[{ value: 'https', label: 'HTTPS endpoint' }, { value: 'socket', label: 'Socket mode (preview)' }]}
            details={mode === 'socket' ? 'For development and testing with a newly created bot. Gamut opens an outbound connection to Teams.' : 'For production, Teams sends messages to a public HTTPS URL.'} />
          {mode === 'https' && !saved && (endpoint ? <Endpoint url={endpoint} /> :
            httpsUnavailable ? <IntegrationSetupNote>Ask your host administrator to configure a public HTTPS URL or Teams relay for this workspace.</IntegrationSetupNote> :
            setup.data?.teamsRelayAvailable && <IntegrationSetupNote>Save the credentials to generate this bot’s public messaging endpoint.</IntegrationSetupNote>)}
        </>,
        action: saved ? undefined : { label: 'Save and continue', busy: create.isPending, busyLabel: 'Saving…', onClick: () => void save() },
      },
      {
        label: 'Configure the bot',
        disabled: !saved,
        subtitle: <ConfigureBot mode={delivery?.deliveryMode ?? mode} />,
        content: saved && <>
          <IntegrationSetupFeedback state="success">Credentials saved for {saved.name || name.effective}.</IntegrationSetupFeedback>
          {(delivery?.deliveryMode ?? mode) === 'https' && (endpoint ? <Endpoint url={endpoint} /> :
            <IntegrationSetupNote>This host needs a public HTTPS endpoint or a connected Teams relay to receive messages.</IntegrationSetupNote>)}
        </>,
      },
      {
        label: 'Install in Teams',
        disabled: !saved,
        lead: saved && <PackageDownload agent={agent} name={saved.name || name.effective} appId={delivery?.appId ?? appId.trim()} />,
        content: <InstallInstructions />,
      },
    ]}
    finish={{ label: 'Done', disabled: !saved, onClick: finish }}
  />
}

export function TeamsConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const { data: agent } = useAgent(integration.agentSlug)
  const teams = publicTeamsDelivery(integration)
  const [secret, setSecret] = useState('')
  const update = useUpdateAgentIntegration()
  if (!teams) return null

  return <DetailCard label="Teams app connection">
    <div className="space-y-4 text-sm">
      <dl className="space-y-2 text-xs">
        <div><dt className="text-muted-foreground">Directory (tenant) ID</dt><dd className="break-all font-mono">{teams.tenantId}</dd></div>
        <div><dt className="text-muted-foreground">Application (client) ID</dt><dd className="break-all font-mono">{teams.appId}</dd></div>
      </dl>
      {teams.deliveryMode === 'socket' ? <p className="text-xs text-muted-foreground">Delivery method · Socket mode (preview)</p> :
        teams.messagingEndpoint ? <Endpoint url={teams.messagingEndpoint} /> : <p className="text-xs text-muted-foreground">A messaging endpoint is required to receive messages from Teams.</p>}
      <PackageDownload agent={agent} appId={teams.appId} name={integration.name || agent?.name || 'Gamut agent'} canUpdate />
      <details><summary className="cursor-pointer font-medium">Installation instructions</summary>
        <div className="space-y-3 pt-2"><p><ConfigureBot mode={teams.deliveryMode} /></p><InstallInstructions /></div>
      </details>
      <details><summary className="cursor-pointer font-medium">Replace client secret</summary>
        <form className="space-y-2 pt-2" onSubmit={async event => {
          event.preventDefault()
          if (!secret.trim() || update.isPending) return
          try {
            await update.mutateAsync({ id: integration.id, config: { clientSecret: secret.trim() } })
            setSecret('')
          } catch { /* The mutation exposes its error below. */ }
        }}>
          <IntegrationSetupField id="teams-replacement-secret" label="New client secret value" type="password" autoComplete="new-password" value={secret} onChange={event => { update.reset(); setSecret(event.target.value) }} required />
          <Button size="sm" variant="outline" type="submit" disabled={!secret.trim() || update.isPending}>Save new secret</Button>
          {update.isError && <IntegrationSetupFeedback state="error">{update.error.message}</IntegrationSetupFeedback>}
          {update.isSuccess && <IntegrationSetupFeedback state="success">Client secret updated.</IntegrationSetupFeedback>}
        </form>
      </details>
    </div>
  </DetailCard>
}
