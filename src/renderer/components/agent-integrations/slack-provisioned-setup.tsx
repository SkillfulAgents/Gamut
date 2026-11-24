import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { agentIntegrationKeys, useAgentIntegration, useCreateAgentIntegration, useUpdateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { useAgent } from '@renderer/hooks/use-agents'
import { ChatSetupBehavior, DEFAULT_CHAT_SETUP_BEHAVIOR, SETTINGS_STEP_LABEL, SETTINGS_STEP_SUBTITLE, slackBehaviorConfig } from './chat-integration-setup-form'
import { IntegrationSetupFeedback } from './integration-setup-layout'
import { IntegrationSetupWizard } from './integration-setup-wizard'
import type { IntegrationSetupProps } from './setup-types'
import { agentAppIconBase64 } from './agent-app-icon'
import { slackAppIdentity } from './slack-app-identity'
import { useInstallProvisionedApp } from './provisioned-app-card'

/**
 * Slack's setup when a connected team directory can create apps: Gamut
 * creates this agent's app (its name, @handle, colour and avatar), then one
 * click installs it to the workspace. No tokens to copy.
 */
export function SlackProvisionedSetupForm({ agentSlug, onClose, provisioning, onManual }: IntegrationSetupProps & {
  provisioning: { directoryId: string; workspace: string }
  onManual: () => void
}) {
  const { data: agent } = useAgent(agentSlug)
  const create = useCreateAgentIntegration()
  const queryClient = useQueryClient()
  const [behavior, setBehavior] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  // The options the app was created with, so changing them afterwards is saved.
  const [createdWith, setCreatedWith] = useState(DEFAULT_CHAT_SETUP_BEHAVIOR)
  const update = useUpdateAgentIntegration()
  const { data: integration } = useAgentIntegration(createdId)
  const { install, waiting, busy: installing, close } = useInstallProvisionedApp(integration ?? null)
  // No name field: the app takes the agent's name, and its card can rename it later.
  const app = slackAppIdentity(agent, '')

  // Installed in the other window: done.
  useEffect(() => {
    if (!integration?.provisionedApp?.installed) return
    close()
    void queryClient.invalidateQueries({ queryKey: agentIntegrationKeys.lists(agentSlug) })
    onClose()
  }, [integration?.provisionedApp?.installed, close, queryClient, agentSlug, onClose])

  const createApp = async () => {
    setError(null)
    try {
      // The avatar as the app's icon; an app without one still works.
      const icon = agent?.avatar ? await agentAppIconBase64(agent).catch(() => undefined) : undefined
      const row = await create.mutateAsync({
        agentSlug, provider: 'slack',
        config: {
          webhooks: true, ...slackBehaviorConfig(behavior),
          provision: {
            directoryId: provisioning.directoryId, name: app.name,
            ...(app.description ? { description: app.description } : {}),
            ...(app.backgroundColor ? { backgroundColor: app.backgroundColor } : {}),
            ...(icon ? { icon } : {}),
          },
        },
        showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout,
      })
      setCreatedId(row.id)
      setCreatedWith(behavior)
      setStep(1)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not create the app')
    }
  }

  const saveOptions = async () => {
    if (!createdId) return
    setError(null)
    try {
      await update.mutateAsync({ id: createdId, config: slackBehaviorConfig(behavior), showToolCalls: behavior.showToolCalls, sessionTimeout: behavior.sessionTimeout })
      setCreatedWith(behavior)
      setStep(2)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the options')
    }
  }

  const startInstall = () => {
    setError(null)
    install().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : 'Could not start the install'))
  }

  const created = !!createdId
  return <IntegrationSetupWizard provider="slack" label="Slack" testId="slack-provisioned-setup"
    description={`DM this agent in Slack, or mention it in channels. Gamut sets up its app in ${provisioning.workspace} for you.`}
    step={step} onStepChange={setStep}
    steps={[
      {
        label: 'Create the app',
        subtitle: `Gamut creates this agent’s Slack app in ${provisioning.workspace}, with its name, @handle and avatar. No tokens to copy.`,
        // The other way in, beside the button it's the alternative to, until the app exists.
        secondary: created ? undefined : { label: 'Set up manually', onClick: onManual, testId: 'slack-setup-manually' },
        // The first click creates the app; after that it's an ordinary Next.
        action: created ? undefined : { label: 'Create app', busy: create.isPending, disabled: !agent, onClick: () => void createApp(), testId: 'slack-provisioned-create' },
      },
      {
        label: SETTINGS_STEP_LABEL,
        subtitle: SETTINGS_STEP_SUBTITLE,
        content: <ChatSetupBehavior provider="slack" value={behavior} onChange={setBehavior} />,
        // Changed after the app was created: saved before moving on to the install.
        action: created && behavior !== createdWith ? { label: 'Continue', busy: update.isPending, onClick: () => void saveOptions() } : undefined,
      },
      {
        label: 'Install the app',
        subtitle: <><strong>Install to {provisioning.workspace}</strong> opens Slack in a new window. Approve the install there.</>,
        content: created && <p className="inline-flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400" data-testid="slack-provisioned-created"><CheckCircle2 className="h-3.5 w-3.5" />App created in {provisioning.workspace}</p>,
        action: { label: `Install to ${provisioning.workspace}`, busy: installing, disabled: !created || !integration, onClick: startInstall, testId: 'slack-provisioned-install', external: true },
      },
    ]}
    feedback={(waiting || error) && <>
      {waiting && <IntegrationSetupFeedback state="pending">Approve the install in Slack. This window updates when you’re done.</IntegrationSetupFeedback>}
      {error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    </>}
    aside={created ? { label: 'Close', onClick: onClose } : undefined}
  />
}
