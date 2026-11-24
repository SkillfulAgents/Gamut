import { useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { EMAIL_ALLOWED_DOMAINS_MAX, emailDomainSchema, type EmailAccessLevel } from '@shared/lib/email-integrations/config-schema'

function domainFrom(entry: string) {
  if (/[/?#]/.test(entry)) {
    try {
      const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`)
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname
    } catch { /* Keep malformed input in the field for correction. */ }
    return entry
  }
  return entry.replace(/^[^@]*@(?=[^@]+$)/, '').toLowerCase()
}

function readDraft(added: string[], draft: string) {
  const domains = new Set(added)
  const remaining: string[] = []
  let error = ''
  // A URL can itself contain commas, semicolons and email addresses in its path or query.
  const entries = draft.match(/https?:\/\/[^\s/?#,;]+(?:[/?#][^\s]*)?|[^\s,;]+/gi) ?? []
  for (const entry of entries) {
    const domain = domainFrom(entry)
    if (!emailDomainSchema.safeParse(domain).success) {
      remaining.push(entry)
      error ||= `“${entry}” isn’t a domain. Enter one like company.com.`
    } else if (!domains.has(domain) && domains.size >= EMAIL_ALLOWED_DOMAINS_MAX) {
      remaining.push(entry)
      error ||= `You can add up to ${EMAIL_ALLOWED_DOMAINS_MAX} domains. Remove a domain or clear the extra entries.`
    } else {
      domains.add(domain)
    }
  }
  return { domains: [...domains], remaining: remaining.join(', '), error }
}

/** The parent validates the visible draft as well as the chips, including submissions before blur. */
export function useEmailDomains(accessLevel: EmailAccessLevel, initial: string[] = []) {
  const [added, setAdded] = useState(initial)
  const [draft, setDraft] = useState('')
  const [showError, setShowError] = useState(false)
  const parsed = readDraft(added, draft)
  const commit = (text: string) => {
    if (!text) return
    const next = readDraft(added, text)
    setAdded(next.domains)
    setDraft(next.remaining)
    setShowError(true)
  }
  const selected = accessLevel === 'allowed-domains'
  return {
    added, draft, error: showError && parsed.error,
    allowedDomains: selected ? parsed.domains : added,
    invalid: selected && (!!parsed.error || !parsed.domains.length),
    edit(text: string) {
      if (/[\s,;]/.test(text)) commit(text)
      else { setDraft(text); setShowError(false) }
    },
    commit: () => commit(draft),
    remove: (domain: string) => setAdded(added.filter(entry => entry !== domain)),
  }
}

export type EmailDomains = ReturnType<typeof useEmailDomains>

export function EmailDomainsInput({ domains, disabled, laterNote }: { domains: EmailDomains; disabled: boolean; laterNote: boolean }) {
  const { added, draft, error } = domains
  const full = added.length >= EMAIL_ALLOWED_DOMAINS_MAX
  return <div className="space-y-2">
    <Label htmlFor="email-domains" className="sr-only">Allowed domains</Label>
    <div className="relative">
      <Input id="email-domains" className="bg-background pr-14 shadow-none" autoComplete="off" spellCheck={false}
        placeholder={full ? `That’s the most you can add (${EMAIL_ALLOWED_DOMAINS_MAX})` : added.length ? 'Add another domain' : 'company.com'}
        value={draft} disabled={disabled || (full && !draft)} aria-invalid={!!error} aria-describedby={error ? 'email-domains-error email-domains-hint' : 'email-domains-hint'}
        onChange={event => domains.edit(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); domains.commit() } }}
        onBlur={domains.commit} />
      <Button type="button" size="xs" variant="ghost" disabled={disabled || !draft.trim()} onClick={domains.commit}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" data-testid="email-domains-add">Add</Button>
    </div>
    {error && <p id="email-domains-error" role="alert" className="text-destructive">{error}</p>}
    {added.length > 0 && <ul aria-label="Added domains" className="flex flex-wrap gap-1.5">
      {added.map(domain => <li key={domain} className="inline-flex items-center gap-0.5 rounded-md border bg-background py-0.5 pl-2 pr-0.5 text-foreground">
        {domain}
        <button type="button" aria-label={`Remove ${domain}`} disabled={disabled} onClick={() => domains.remove(domain)}
          className="grid size-4 place-items-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
          <X aria-hidden="true" className="size-3" />
        </button>
      </li>)}
    </ul>}
    <p id="email-domains-hint">{!added.length && 'Add at least one domain. '}Subdomains need their own entry.{laterNote && ' You can add more later.'}</p>
  </div>
}
