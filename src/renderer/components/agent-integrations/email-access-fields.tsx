import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { useUser } from '@renderer/context/user-context'
import { useAgentMembers } from '@renderer/hooks/use-agent-members'
import { useAgentIntegrationSetup } from '@renderer/hooks/use-agent-integrations'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import { Label } from '@renderer/components/ui/label'
import { MemberRosterPopover } from '@renderer/components/sharing/member-roster-popover'
import { UserAvatar } from '@renderer/components/ui/user-avatar'
import { UserAvatarStack } from '@renderer/components/ui/user-avatar-stack'
import type { UserSummary } from '@shared/lib/user-profile-schema'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { IntegrationSetupChoices } from './integration-setup-layout'
import { EMAIL_ALLOWED_DOMAINS_MAX, emailDomainSchema, type EmailAccessLevel } from '@shared/lib/email-integrations/config-schema'

/** Each choice as one line that needs no second: who the agent hears from, and who it can write to. */
export const emailAccessOptions = [
  { value: 'agent-users', label: 'Only people with access to this agent' },
  { value: 'agent-users-and-replies', label: 'People with access, plus anyone it emails first' },
  { value: 'allowed-domains', label: 'Only people at domains you choose' },
  { value: 'anyone', label: 'Anyone' },
] as const

/** Shown under the choices unless they're anyone's: what happens to mail that can't be trusted. */
export const EMAIL_SENDER_CHECKS_NOTE = 'Mail that fails sender checks is rejected.'

/**
 * Who an agent's inbox talks to: four choices in one list, each a single line
 * that says what it means, so all four can be read without opening anything.
 * What the chosen one needs or shows opens under its own row: the people it
 * covers, the domains to list, or what a public inbox opens the agent to.
 */
export function EmailAccessFields({ value, onChange, domains, onDomainsChange, disabled = false, agentSlug, canPreview = true, hideLabel = false, senderNote = true, domainsLaterNote = false }: {
  agentSlug: string; canPreview?: boolean
  value: EmailAccessLevel; onChange: (value: EmailAccessLevel) => void; domains: string; onDomainsChange: (value: string) => void; disabled?: boolean
  /** Where a heading above already asks the question. */
  hideLabel?: boolean
  /** Off where the caller shows `EMAIL_SENDER_CHECKS_NOTE` itself, e.g. in a footer. */
  senderNote?: boolean
  /** During setup: say the list of domains can grow later, so it needn't be complete now. */
  domainsLaterNote?: boolean
}) {
  const labelId = useId()
  const { user, isAuthMode } = useUser()
  const { data: platform } = usePlatformAuthStatus()
  const setup = useAgentIntegrationSetup(agentSlug, 'platform-email', undefined, canPreview)
  const yourEmail = (isAuthMode ? user?.email : platform?.email)?.toLowerCase()
  const members = setup.data?.agentUserEmails

  // Faces for the people the inbox counts as having access: the roster's, where it knows them (signed-in
  // workspaces), or one made from the address alone.
  const roster = useAgentMembers(agentSlug, canPreview)
  const known = new Map((roster.data ?? []).map(member => [member.email?.toLowerCase(), member]))
  const faces: UserSummary[] = (members ?? []).map(email => known.get(email) ?? { id: email, email })

  // The people "with access" are shown, so the choice isn't taken on trust: the sidebar's stack of faces
  // beside the words, with the same roster on hover. Only who has access today; inviting is the agent's own Share.
  const people = !canPreview ? <p>An owner can see who has access.</p>
    : !members ? <p>{setup.isPending ? 'Loading who has access…' : 'Couldn’t load who has access.'}</p>
      : members.length === 0 ? <p>No one with access has an email address yet.</p>
        : <MemberRosterPopover users={faces} variant="page" align="start" className="-mx-1.5 h-6 gap-2 px-1.5" rosterLabel="People with access"
            label={`${faces.length} ${faces.length === 1 ? 'person' : 'people'} with access`}
            testIds={{ trigger: 'email-access-people', count: 'email-access-people-count', list: 'email-access-people-list' }}
            // One quiet line: the words, the faces beside them, and a chevron to say there's a list behind them.
            trigger={<>
              <span>People with access</span>
              <UserAvatarStack users={faces} maxFaces={5} className="pl-0.5" overflowTestId="email-access-people-count"
                overflowClassName="bg-[color-mix(in_srgb,hsl(var(--foreground))_10%,hsl(var(--background)))] text-foreground" />
              <ChevronDown aria-hidden="true" className="-ml-1 size-3.5 text-muted-foreground/70" />
            </>}>
            <ul aria-label="People with access" className="max-h-80 overflow-y-auto">
              {faces.map(person => (
                <li key={person.id} className="flex items-center gap-2 px-2 py-2">
                  <UserAvatar user={person} size={28} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{person.name || person.email}</p>
                    {person.name && <p className="truncate text-[11px] text-muted-foreground">{person.email}</p>}
                  </div>
                  {person.email?.toLowerCase() === yourEmail && <span className="text-[11px] text-muted-foreground">You</span>}
                </li>
              ))}
            </ul>
          </MemberRosterPopover>

  const details: Record<EmailAccessLevel, ReactNode> = {
    'agent-users': people,
    'agent-users-and-replies': people,
    'allowed-domains': <EmailDomainsInput value={domains} onChange={onDomainsChange} disabled={disabled} laterNote={domainsLaterNote} />,
    anyone: <p role="note" className="text-amber-700 dark:text-amber-400">Anyone who emails this address can put the agent to work with its tools. Keep approvals on for sensitive actions.</p>,
  }

  return <div className="space-y-3">
    <p id={labelId} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>Email access</p>
    <IntegrationSetupChoices options={emailAccessOptions} value={value} onChange={onChange} disabled={disabled} details={details[value]}
      labelledBy={labelId} testId={option => `email-access-${option}`} />
    {senderNote && value !== 'anyone' && <p className="text-xs text-muted-foreground">{EMAIL_SENDER_CHECKS_NOTE}</p>}
  </div>
}
/** What someone might type or paste for a domain, down to the domain: `@Acme.com`, `sam@acme.com`, `https://acme.com/`. */
function domainFrom(entry: string) {
  return entry.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^.*@/, '').replace(/\/.*$/, '')
}

/**
 * The allowed domains, one at a time: type one and Add (or Enter), and it
 * joins the list under the field, where each can be taken off again. A pasted
 * list is taken apart, so nothing depends on getting separators right. The
 * value stays the comma-separated string its callers hold.
 */
function EmailDomainsInput({ value, onChange, disabled, laterNote }: { value: string; onChange: (value: string) => void; disabled: boolean; laterNote: boolean }) {
  const list = parseEmailDomains(value)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const full = list.length >= EMAIL_ALLOWED_DOMAINS_MAX

  // Adds every domain in the text; what isn't one stays in the field, with why.
  const add = (text: string) => {
    const entries = [...new Set(text.split(/[\s,;]+/).map(domainFrom).filter(Boolean))]
    const valid = entries.filter(entry => emailDomainSchema.safeParse(entry).success)
    const invalid = entries.filter(entry => !valid.includes(entry))
    const next = [...new Set([...list, ...valid])].slice(0, EMAIL_ALLOWED_DOMAINS_MAX)
    if (next.length !== list.length) onChange(next.join(', '))
    setDraft(invalid.join(', '))
    setError(invalid.length ? `“${invalid[0]}” isn’t a domain. Enter one like company.com.` : null)
  }

  return <div className="space-y-2">
    <Label htmlFor="email-domains" className="sr-only">Allowed domains</Label>
    <div className="relative">
      <Input id="email-domains" className="bg-background pr-14 shadow-none" autoComplete="off" spellCheck={false}
        placeholder={full ? `That’s the most you can add (${EMAIL_ALLOWED_DOMAINS_MAX})` : list.length ? 'Add another domain' : 'company.com'}
        value={draft} disabled={disabled || full} aria-invalid={!!error} aria-describedby="email-domains-hint"
        // A separator typed or pasted adds what came before it, as Enter does.
        onChange={event => { if (/[\s,;]/.test(event.target.value)) add(event.target.value); else { setDraft(event.target.value); setError(null) } }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(draft) } }}
        // So a domain typed but not added still counts when the form is submitted.
        onBlur={() => { if (draft.trim()) add(draft) }} />
      <Button type="button" size="xs" variant="ghost" disabled={disabled || !draft.trim()} onClick={() => add(draft)}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" data-testid="email-domains-add">Add</Button>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {list.length > 0 && <ul aria-label="Added domains" className="flex flex-wrap gap-1.5">
      {list.map(domain => <li key={domain} className="inline-flex items-center gap-0.5 rounded-md border bg-background py-0.5 pl-2 pr-0.5 text-foreground">
        {domain}
        <button type="button" aria-label={`Remove ${domain}`} disabled={disabled} onClick={() => onChange(list.filter(entry => entry !== domain).join(', '))}
          className="grid size-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
          <X aria-hidden="true" className="size-3" />
        </button>
      </li>)}
    </ul>}
    <p id="email-domains-hint">Subdomains need their own entry.{laterNote && ' You can add more later.'}</p>
  </div>
}

export function parseEmailDomains(value: string) { return [...new Set(value.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean))] }
