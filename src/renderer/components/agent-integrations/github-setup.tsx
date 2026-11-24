import { useEffect, useRef, useState } from 'react'
import { useAgent } from '@renderer/hooks/use-agents'
import { useAgentIntegration, useAgentIntegrationSetup, useAuthorizeAgentIntegration, useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useLoginWindow } from '@renderer/hooks/use-login-window'
import { Button } from '@renderer/components/ui/button'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import type { PublicAgentIntegration } from '@shared/lib/agent-integrations/public'
import { isPublicGitHubIntegration } from '@shared/lib/task-manager-integrations/github/public'
import type { IntegrationSetupProps } from './setup-types'
import { IntegrationSetupChoices, IntegrationSetupField, IntegrationSetupFeedback } from './integration-setup-layout'
import { IntegrationSetupWizard } from './integration-setup-wizard'

/** Where the agent's app is created: GitHub keeps a person's apps and an organization's in different places. */
const OWNERS = [
  { value: 'personal', label: 'Your personal account' },
  { value: 'organization', label: 'An organization' },
] as const
type Owner = typeof OWNERS[number]['value']

export function GitHubSetupForm({ agentSlug, onClose, initial }: IntegrationSetupProps) {
  const { data: agent } = useAgent(agentSlug)
  const setup = useAgentIntegrationSetup(agentSlug, 'github')
  // No name field: the app takes the agent's name (or one an agent suggested); GitHub's own page can change it.
  const name = initial?.name?.slice(0, 34) ?? null
  const [organization, setOrganization] = useState(initial?.organization ?? '')
  const [owner, setOwner] = useState<Owner>(initial?.organization ? 'organization' : 'personal')
  // The name only counts while "An organization" is the choice; it is kept if they switch away and back.
  const org = owner === 'organization' ? organization.trim() : ''
  const orgMissing = owner === 'organization' && !org
  const [id, setId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const create = useCreateAgentIntegration()
  const authorize = useAuthorizeAgentIntegration()
  const login = useLoginWindow()
  const closeLogin = login.close
  const { data: integration, error: refreshError } = useAgentIntegration(id)
  const completed = useRef(false)
  const displayName = (name ?? agent?.name ?? agentSlug).slice(0, 34).trim()
  const connected = !!integration?.hasCredentials
  // GitHub names the app's account after its slug, which can differ from the name typed here.
  const handle = integration && isPublicGitHubIntegration(integration) ? integration.settings.botLogin?.replace(/\[bot\]$/, '') : undefined
  // Once GitHub reports the app installed, the setup moves on to how to use it.
  useEffect(() => {
    if (!connected || completed.current) return
    completed.current = true; closeLogin(); setError(null); setStep(2)
  }, [connected, closeLogin])
  const connect = async () => {
    // The rail lets someone skip ahead; an organization with no name would quietly become their own account.
    if (orgMissing && !id) { setError('Enter the organization’s name first.'); setStep(0); return }
    setError(null)
    try {
      await login.open(async () => {
        let integrationId = id
        if (!integrationId) {
          const row = await create.mutateAsync({ agentSlug, provider: 'github', name: displayName, config: org ? { organization: org } : {} })
          integrationId = row.id; setId(row.id)
        }
        return (await authorize.mutateAsync({ id: integrationId, agentSlug, config: {} })).url
      })
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect GitHub') }
  }
  const busy = create.isPending || authorize.isPending
  const failure = error ?? setup.error?.message ?? refreshError?.message ?? integration?.healthMessage
  const waiting = login.waiting && !integration?.reconnectRequired
  return <IntegrationSetupWizard provider="github" label="GitHub"
    description="Mention this agent in issues and pull requests."
    step={step} onStepChange={setStep}
    steps={[
      {
        // Its own step: where the app is created is a decision, and it can't be changed once the app exists.
        label: 'Choose the account',
        subtitle: 'Choose the account that owns the repositories this agent will work in.',
        content: <IntegrationSetupChoices label="Account" options={OWNERS} value={owner} onChange={next => { setOwner(next); setError(null) }} disabled={busy || !!id}
          testId={value => `github-owner-${value}`}
          details={owner === 'organization' && <IntegrationSetupField id="github-organization" label="Organization name" hideLabel placeholder="acme" autoComplete="off" spellCheck={false}
            // Straight to the name on picking it; not when the setup opens with one already filled in.
            autoFocus={!initial?.organization}
            value={organization} onChange={event => { setOrganization(event.target.value); setError(null) }} disabled={busy || !!id}
            onKeyDown={event => { if (event.key === 'Enter' && org) { event.preventDefault(); setStep(1) } }}
            hint="Its name in GitHub, as in github.com/acme." />} />,
        action: { label: 'Next', disabled: orgMissing, onClick: () => setStep(1), testId: 'integration-setup-next' },
      },
      {
        label: 'Create the app',
        subtitle: <><strong>Connect GitHub</strong> opens GitHub with the app’s settings filled in. Create it, install it and choose the repositories it can access.</>,
        action: connected ? undefined : { label: id ? 'Continue setup' : 'Connect GitHub', busy, disabled: !displayName || !setup.data, onClick: () => void connect(), external: true },
      },
      {
        label: 'Mention it to start',
        subtitle: <>Mention {handle ? <strong>@{handle}</strong> : 'the app’s name'} in an issue or pull request comment. Anyone with write access to the repository can follow up in the same conversation.</>,
        action: { label: 'Done', disabled: !connected, onClick: onClose },
      },
    ]}
    feedback={!connected && (failure || waiting) && <>
      {failure && <IntegrationSetupFeedback state="error">{failure}</IntegrationSetupFeedback>}
      {waiting && <IntegrationSetupFeedback state="pending">Finish creating and installing the app in GitHub. This window updates when you’re done.</IntegrationSetupFeedback>}
    </>}
  />
}

export function GitHubConnectionSettings({ integration }: { integration: PublicAgentIntegration }) {
  const authorize = useAuthorizeAgentIntegration()
  const login = useLoginWindow()
  const closeLogin = login.close
  const [error, setError] = useState<string | null>(null)
  const pending = (integration.authorizationPendingUntil ?? 0) > Date.now()
  useEffect(() => { if (integration.hasCredentials && !pending) closeLogin() }, [integration.hasCredentials, pending, closeLogin])
  if (!isPublicGitHubIntegration(integration)) return null
  const connect = async () => {
    setError(null)
    try { await login.open(async () => (await authorize.mutateAsync({ id: integration.id, agentSlug: integration.agentSlug, config: {} })).url) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect GitHub') }
  }
  return <DetailCard label="GitHub Account">
    <div className="space-y-3 text-sm">
      {integration.settings.botLogin && <p>{integration.settings.botLogin}{integration.settings.account ? ` · ${integration.settings.account}` : ''}</p>}
      {integration.settings.appUrl && <a className="text-primary underline" href={integration.settings.appUrl} target="_blank" rel="noreferrer">View GitHub App</a>}
      <p className="text-xs text-muted-foreground">The app receives issue and pull request events through webhooks. Manage its repository access in GitHub.</p>
      <Button size="sm" variant="outline" disabled={authorize.isPending} onClick={() => void connect()}>{integration.hasCredentials ? 'Reconnect GitHub' : 'Continue setup'}</Button>
      {pending && <IntegrationSetupFeedback state="pending">Finish installation in GitHub.</IntegrationSetupFeedback>}
      {(error || integration.healthMessage) && <IntegrationSetupFeedback state="error">{error ?? integration.healthMessage}</IntegrationSetupFeedback>}
    </div>
  </DetailCard>
}
