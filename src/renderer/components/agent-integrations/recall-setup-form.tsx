import { useState } from 'react'
import { Video } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { useAgent } from '@renderer/hooks/use-agents'
import { useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { recallConfigSchema } from '@shared/lib/meeting-integrations/recall/config'
import { MEETING_INSTRUCTIONS_MAX_CHARS, MEETING_RECORDING_RETENTION_HOURS } from '@shared/lib/meeting-integrations/schemas'
import { IntegrationSetupCallout, IntegrationSetupField, IntegrationSetupFeedback, IntegrationSetupTextArea } from './integration-setup-layout'
import { IntegrationSetupWizard } from './integration-setup-wizard'
import { Face, type IntroAgent } from './integration-setup-intro'
import danaPhoto from '@renderer/assets/integration-intros/meeting-dana.jpg'
import type { IntegrationSetupProps } from './setup-types'
import { useIntegrationSetupName } from './use-integration-setup-name'

/**
 * Meetings run through the Platform, so there is no key to paste: the choices
 * are the name the agent appears under in calls (the agent's own name until
 * edited) and standing instructions for every meeting it joins. The form is
 * offered only where the deployment can host meeting bots (see provider availability).
 */
export function RecallSetupForm({ agentSlug, onClose, onIntegrationCreated, initial }: IntegrationSetupProps) {
  const { data: agent } = useAgent(agentSlug)
  const name = useIntegrationSetupName(agent?.name ?? '', initial?.name, 100)
  const [instructions, setInstructions] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const create = useCreateAgentIntegration()
  const navigate = useNavigate()
  const retentionDays = Math.round(MEETING_RECORDING_RETENTION_HOURS / 24)

  const submit = async () => {
    if (create.isPending) return
    setError(null)
    const parsed = recallConfigSchema.safeParse({
      ...(name.input.value.trim() ? { botName: name.input.value.trim() } : {}),
      ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      // Back to the step whose field needs fixing.
      setStep(issue?.path[0] === 'botName' ? 0 : 1)
      setError(issue?.message ?? 'Check the name and instructions')
      return
    }
    try {
      const result = await create.mutateAsync({ agentSlug, provider: 'recall', name: parsed.data.botName ?? agent?.name, config: parsed.data })
      onClose()
      if (onIntegrationCreated) onIntegrationCreated(result.id)
      else void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: result.id } })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not set up meetings') }
  }

  return <IntegrationSetupWizard provider="recall" label="Meetings" heading="Bring this agent to meetings"
    description="It joins Zoom, Google Meet and Microsoft Teams calls as a voice participant."
    step={step} onStepChange={setStep}
    steps={[
      {
        label: 'Choose its name',
        subtitle: 'This is the name people see in the call.',
        content: <>
          <IntegrationSetupField id="recall-bot-name" label="Name in calls" hideLabel {...name.input} placeholder={name.input.placeholder || 'Agent'} disabled={create.isPending} />
          <CallPreview agent={{ slug: agentSlug, name: name.effective || 'Agent', avatar: agent?.avatar ?? null }} />
        </>,
      },
      {
        label: 'Add instructions',
        // What to do in the text's own colour; that it can wait, quieter, on a line of its own.
        subtitle: <><span className="text-foreground">Tell it how to act in every meeting.</span><br />You can skip this and add it later.</>,
        content: <IntegrationSetupTextArea id="recall-instructions" label="Instructions for every meeting" hideLabel rows={4} placeholder="Introduce yourself when asked. Keep answers under two sentences. Track action items with owners." value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={MEETING_INSTRUCTIONS_MAX_CHARS} disabled={create.isPending} />,
      },
      {
        label: 'Send it to a meeting',
        subtitle: 'After you connect, paste a meeting’s invite link on the next page. The host may need to let it in from the waiting room.',
        content: <IntegrationSetupCallout title="Good to know" items={[
          'It records each call’s audio to take notes, and says so in the call chat when it joins.',
          `You can replay recordings from the integration’s page for ${retentionDays} days.`,
          'Meeting time is billed to your Gamut account.',
        ]} />,
      },
    ]}
    feedback={error && <IntegrationSetupFeedback state="error">{error}</IntegrationSetupFeedback>}
    finish={{ label: 'Connect', busyLabel: 'Connecting…', busy: create.isPending, onClick: () => void submit() }}
  />
}

/**
 * Where the name shows up: the tag on the agent's tile in a call, as the other
 * people in it see it. It follows the field as it's typed, on one line however
 * long; the faded tile beside it is only there to make it read as a call.
 *
 * Drawn as a picture, not a control, like the sender's preview in the inbox
 * setup: a tinted, borderless panel holding a small call window that floats on
 * a shadow and runs off the panel's bottom edge.
 */
function CallPreview({ agent }: { agent: IntroAgent }) {
  return (
    <figure className="overflow-hidden rounded-xl bg-muted/70 px-5 pt-3.5 text-left text-xs dark:bg-muted/40">
      <figcaption className="pb-3 text-[11px] text-muted-foreground">Preview · How it shows in a call</figcaption>
      <div className="-mb-4 overflow-hidden rounded-lg border bg-background shadow-md">
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          <Video aria-hidden="true" className="h-3 w-3" />
          Weekly sync
        </div>
        {/* Two tiles, so each is wide enough for a name of some length: the agent and one person. */}
        <div className="grid grid-cols-2 gap-1.5 p-2 pb-6">
          {/* The agent's tile first, ringed as the one speaking, so the eye lands on its name. */}
          <div className="relative flex aspect-video items-center justify-center rounded-md bg-muted pb-3 ring-2 ring-brand">
            <Face agent={agent} size={36} />
            <span className="absolute bottom-1.5 left-1.5 max-w-[calc(100%-0.75rem)] truncate rounded bg-black/55 px-1.5 py-px text-[11px] text-white" data-testid="recall-name-preview">{agent.name}</span>
          </div>
          <div aria-hidden="true" className="relative aspect-video overflow-hidden rounded-md bg-muted opacity-40">
            <img src={danaPhoto} alt="" className="size-full object-cover" />
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-px text-[11px] text-white">Dana</span>
          </div>
        </div>
      </div>
    </figure>
  )
}
