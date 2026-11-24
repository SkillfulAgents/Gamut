import { useId, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Mail } from 'lucide-react'
import { useAgent } from '@renderer/hooks/use-agents'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { useAgentIntegrationSetup, useCreateAgentIntegration } from '@renderer/hooks/use-agent-integrations'
import { emailSetupSchema, type EmailAccessLevel } from '@shared/lib/email-integrations/config-schema'
import { EMAIL_SENDER_CHECKS_NOTE, EmailAccessFields, parseEmailDomains } from './email-access-fields'
import { cn } from '@shared/lib/utils/cn'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { IntegrationSetupField, IntegrationSetupFeedback } from './integration-setup-layout'
import { IntegrationSetupWizard } from './integration-setup-wizard'
import type { IntegrationSetupProps } from './setup-types'

export function EmailIntegrationSetupForm({ agentSlug, onClose, initial, onIntegrationCreated }: IntegrationSetupProps) {
  const previewId = useId()
  const setup = useAgentIntegrationSetup(agentSlug, 'platform-email')
  const { data: agent } = useAgent(agentSlug)
  const { data: platform } = usePlatformAuthStatus()
  const [localPart, setLocalPart] = useState(() => initial?.localPart ?? (agent?.name ?? agentSlug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64))
  const [displayName, setDisplayName] = useState(initial?.displayName ?? initial?.name ?? agent?.name ?? agentSlug)
  const [accessLevel, setAccessLevel] = useState<EmailAccessLevel>('agent-users-and-replies')
  const [domains, setDomains] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const create = useCreateAgentIntegration()
  const navigate = useNavigate()
  const setupError = error ?? setup.error?.message

  const submit = async () => {
    if (create.isPending) return
    setError(null)
    const parsed = emailSetupSchema.safeParse({ localPart, displayName, accessLevel, allowedDomains: parseEmailDomains(domains) })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      // Back to the step whose field needs fixing.
      if (issue?.path[0] === 'localPart') setStep(0)
      else if (issue?.path[0] === 'displayName') setStep(1)
      setError(issue?.message ?? 'Check your email settings')
      return
    }
    try {
      const result = await create.mutateAsync({ agentSlug, provider: 'platform-email', name: parsed.data.displayName, config: parsed.data })
      onClose()
      if (onIntegrationCreated) onIntegrationCreated(result.id)
      else void navigate({ to: '/agents/$slug/chat/$integrationId', params: { slug: agentSlug, integrationId: result.id } })
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create inbox') }
  }

  return <IntegrationSetupWizard provider="platform-email" label="Email" heading="Give this agent its own email inbox"
    description="People email it like a teammate, and it answers from its own address."
    step={step} onStepChange={setStep}
    steps={[
      {
        label: 'Choose its address',
        content: <>
          <div>
            {/* The asterisk ties the label to the line under the field; it isn't read out, the line is. */}
            <Label htmlFor="email-slug" className="text-xs font-normal">Email address<span aria-hidden="true" className="text-muted-foreground">*</span></Label>
            {/*
              The whole address in one field: the name you type, then the domain it lives at, fixed.
              The input fills the box; the domain is drawn over it, after an invisible copy of what
              is typed so it follows the text, and lets clicks through to the input.
            */}
            <div className="relative mt-1.5">
              <Input aria-describedby={`${previewId} ${previewId}-fixed`} id="email-slug" className="bg-background text-sm shadow-none md:text-sm" value={localPart} onChange={event => setLocalPart(event.target.value)} required maxLength={64} disabled={create.isPending} />
              {setup.data?.emailDomain && (
                <span className={cn('pointer-events-none absolute inset-px flex px-3 items-center overflow-hidden whitespace-pre text-sm', create.isPending && 'opacity-50')}>
                  <span aria-hidden="true" className="invisible">{localPart}</span>
                  <span id={previewId} className="min-w-0 truncate text-muted-foreground">@{setup.data.emailDomain}</span>
                </span>
              )}
            </div>
            {!setup.data?.emailDomain && <p id={previewId} className="mt-1.5 text-xs text-muted-foreground" aria-live="polite">
              {setup.isPending ? 'Loading email domain…' : 'Your domain will be checked when you create the inbox.'}
            </p>}
            <p id={`${previewId}-fixed`} className="mt-1.5 text-xs text-muted-foreground"><span aria-hidden="true">*</span>This can’t be changed later.</p>
          </div>
        </>,
        // On the step that shows the domain, not after the choices it has nothing to do with.
        note: <>A new domain is set up for you.<br />This can take a few minutes.</>,
      },
      {
        label: 'Name the sender',
        content: <>
          <IntegrationSetupField id="email-name" label="Sender name" value={displayName} onChange={event => setDisplayName(event.target.value)} required maxLength={200} disabled={create.isPending} />
          <SenderPreview name={displayName.trim() || agent?.name || agentSlug} />
        </>,
      },
      {
        label: 'Choose who it talks to',
        subtitle: 'Choose who can email this agent, and who it can email.',
        content: <>
          <EmailAccessFields agentSlug={agentSlug} value={accessLevel} onChange={setAccessLevel} domains={domains} onDomainsChange={setDomains} disabled={create.isPending} hideLabel senderNote={false} domainsLaterNote />
        </>,
        // In the button row, like the address step's note, rather than trailing under the choices.
        note: accessLevel !== 'anyone' ? EMAIL_SENDER_CHECKS_NOTE : undefined,
      },
    ]}
    feedback={(setupError || !platform?.connected) && <>
      {setupError && <IntegrationSetupFeedback state="error">{setupError}</IntegrationSetupFeedback>}
      {!platform?.connected && <IntegrationSetupFeedback state="error">Connect your Gamut account to set up email.</IntegrationSetupFeedback>}
    </>}
    finish={{ label: 'Create inbox', busyLabel: 'Creating inbox…', busy: create.isPending, disabled: !platform?.connected, onClick: () => void submit() }}
  />
}

/**
 * Where the sender name shows up: the top line of an inbox row, as it reads in
 * someone else's mail app. It follows the field as it's typed; the faded row
 * under it is only there to make it read as an inbox.
 *
 * Drawn as a picture, not a control: a tinted, borderless panel (the fields
 * above are white with a border) holding a small mail window that floats on a
 * shadow and runs off the panel's bottom edge, like the pictures on the intros.
 */
function SenderPreview({ name }: { name: string }) {
  return (
    <figure className="overflow-hidden rounded-xl bg-muted/70 px-5 pt-3.5 text-left text-xs dark:bg-muted/40">
      <figcaption className="pb-3 text-[11px] text-muted-foreground">Preview · How it shows in someone’s inbox</figcaption>
      <div className="-mb-4 overflow-hidden rounded-lg border bg-background shadow-md">
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-[11px] text-muted-foreground">
          <Mail aria-hidden="true" className="h-3 w-3" />
          Inbox
        </div>
        <InboxRow name={name} time="9:41" subject="March invoices" snippet="Here they are, totalled by client." />
        <InboxRow name="Dana Lee" time="Yesterday" subject="Lunch on Friday?" snippet="Want to try the new place on 5th?" faded />
      </div>
    </figure>
  )
}

function InboxRow({ name, time, subject, snippet, faded }: { name: string; time: string; subject: string; snippet: string; faded?: boolean }) {
  return (
    <div className={cn('flex items-start gap-2.5 px-3 py-2.5', faded ? 'opacity-40' : 'bg-muted/40')} aria-hidden={faded || undefined}>
      {/* Most mail apps draw a sender they don't know as an initial. */}
      <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-foreground/10 text-[11px] text-foreground">{name.charAt(0).toUpperCase()}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate', faded ? 'text-foreground' : 'font-medium text-foreground')} data-testid={faded ? undefined : 'email-sender-preview'}>{name}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{time}</span>
        </span>
        <span className="block truncate text-muted-foreground"><span className="mr-1.5 text-foreground/80">{subject}</span>{snippet}</span>
      </span>
    </div>
  )
}
