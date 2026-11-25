import { useState, type ReactNode } from 'react'
import { ChevronRight, Globe, KeyRound, Loader2, UserPlus, Users } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { cn } from '@shared/lib/utils/cn'
import type { LoginVaultInfo, VaultOffer } from './login-request'
import type { LoginViaProvider } from './use-login-request'
import { LOGIN_PRIMARY_BUTTON, LoginActionRow, LoginStepBack } from './login-parts'

/**
 * The sign-in form's vault parts: the choice among the user's saved accounts
 * for the site, "Save for later", and "Or sign in with Google, …". Metadata
 * only: a saved value never reaches the renderer, it goes from the vault into
 * the page on the host.
 */

/** Said wherever saving or using an account here shares it with the others who can use the agent (its members and admins). */
export function sharedAgentNotice(otherMembers: number, site: string): string {
  return `${otherMembers} other ${otherMembers === 1 ? 'person' : 'people'} can use this agent. They will be able to have it sign in to ${site} as you.`
}

function SharedNotice({ otherMembers, site }: { otherMembers: number; site: string }) {
  if (otherMembers === 0) return null
  return (
    <p className="flex items-start gap-1.5 text-2xs text-amber-700 dark:text-amber-400" data-testid="login-shared-notice">
      <Users className="mt-0.5 h-3 w-3 shrink-0" />
      {sharedAgentNotice(otherMembers, site)}
    </p>
  )
}

/** What a saved account holds, in a few words. */
export function describeOffer(offer: Pick<VaultOffer, 'parts' | 'via' | 'rejected'>): string {
  if (offer.via) return `Signs in with ${offer.via.name} (${offer.via.username})`
  const parts = offer.parts.map((part) => (part === 'password' ? 'password' : part.replace(/^text:/, '')))
  const saved = parts.length ? `Saved: ${parts.join(', ')}` : 'Username only'
  return offer.rejected ? `${saved} · the site turned it down` : saved
}

/**
 * The form's first step when the user has saved accounts for the site: one
 * click uses one (and lets this agent use it from now on); "Use a different
 * account" goes on to the fields.
 */
export function AccountChooser({
  offers,
  site,
  otherMembers,
  disabled,
  pendingId,
  onUse,
  onDifferent,
}: {
  offers: VaultOffer[]
  site: string
  otherMembers: number
  disabled: boolean
  /** The account being signed in with, while that runs. */
  pendingId: string | null
  onUse: (offer: VaultOffer) => void
  onDifferent: () => void
}) {
  const row = 'flex w-full items-center gap-3 px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50'
  return (
    <div className="space-y-1.5" data-testid="login-vault-accounts">
      {offers.some((offer) => !offer.granted) && <SharedNotice otherMembers={otherMembers} site={site} />}
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
        {offers.map((offer) => (
          <button
            key={offer.id}
            type="button"
            onClick={() => onUse(offer)}
            disabled={disabled}
            className={row}
            data-testid={`login-vault-account-${offer.id}`}
          >
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">{offer.label || offer.username}</span>
              <span className="block truncate text-2xs text-muted-foreground">
                {offer.label ? `${offer.username} · ` : ''}
                {describeOffer(offer)}
              </span>
            </span>
            {pendingId === offer.id
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Signing in" />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          </button>
        ))}
        <button type="button" onClick={onDifferent} disabled={disabled} className={row} data-testid="login-different-account">
          <UserPlus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 text-xs text-foreground">Use a different account</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </div>
    </div>
  )
}

/**
 * On a step of two-step verification (the ways to verify, or a code) for an
 * account of the user's: have the agent add a passkey, or an authenticator
 * app next to the verification the account already has, once signed in, so later sign-ins
 * need nothing from them. Requested at once (the agent hears it as the
 * user's own message once its turn ends), apart from how the card is
 * answered, so it is not taken back here.
 */
export function AddSignInMethodBox({
  addMethod,
  onRequest,
  disabled,
}: {
  addMethod: NonNullable<LoginVaultInfo['addMethod']>
  onRequest: () => Promise<void>
  disabled: boolean
}) {
  const [requested, setRequested] = useState(addMethod.requested)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = async () => {
    setSending(true)
    setError(null)
    try {
      await onRequest()
      setRequested(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent could not be asked')
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/30 p-2.5" data-testid="login-add-method-section">
      <label className="flex items-start gap-2 text-xs text-foreground">
        <Checkbox
          checked={requested}
          onCheckedChange={(value) => {
            if (value === true) void request()
          }}
          disabled={disabled || requested || sending}
          className="mt-0.5"
          data-testid="login-add-method"
          aria-describedby="login-add-method-hint"
        />
        <span className="min-w-0">
          <span className="block font-medium">Also add a passkey or authenticator app</span>
          <span id="login-add-method-hint" className="block text-2xs text-muted-foreground">
            {requested
              ? <>Asked: once signed in, the agent adds a passkey to <span className="break-all">{addMethod.username}</span>, or an authenticator app next to the two-step verification it already has.</>
              : <>Once signed in, the agent adds a passkey to <span className="break-all">{addMethod.username}</span>, or an authenticator app next to the two-step verification it already has, so later sign-ins need nothing from you.</>}
          </span>
        </span>
      </label>
      {error && <p className="text-2xs text-destructive" role="alert" data-testid="login-add-method-error">{error}</p>}
    </div>
  )
}

/**
 * "Securely save in Gamut Vault": the account goes to the user's vault, and
 * this agent may use it. One line, on the row with the card's buttons; what
 * it does is its description.
 */
export function SaveToggle({ checked, onCheckedChange, site, username, disabled }: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  site: string
  /** Whose account it is, when already known. */
  username: string | null
  disabled: boolean
}) {
  return (
    <label className="flex min-w-0 items-center gap-2.5 text-xs text-muted-foreground" data-testid="login-save-section">
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        // On, it takes Submit's blue: the two go together.
        className="data-[state=checked]:bg-blue-600"
        data-testid="login-save"
        aria-describedby="login-save-hint"
      />
      Securely save in Gamut Vault
      <span id="login-save-hint" className="sr-only">
        Saves {username ?? 'this account'} to your vault for {site}, so this agent can sign in again without asking you.
      </span>
    </label>
  )
}

/**
 * What saving asks or says besides the toggle: the username to save under,
 * when the page shows none, and who else can use the agent. Above the
 * buttons' row, so the row keeps its height.
 */
export function SaveDetails({ askUsername, usernameValue, onUsernameChange, usernameMissing = false, otherMembers, site, disabled }: {
  /** The page shows no username field and none is known: ask for it to save. */
  askUsername: boolean
  usernameValue: string
  onUsernameChange: (value: string) => void
  /** Sign in was clicked without the username to save under. */
  usernameMissing?: boolean
  otherMembers: number
  site: string
  disabled: boolean
}) {
  if (!askUsername && otherMembers === 0) return null
  return (
    <div className="space-y-2" data-testid="login-save-details">
      {askUsername && (
        <div className="space-y-1">
          <Input
            value={usernameValue}
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder="Username or email of this account"
            aria-label="Username or email of this account"
            aria-invalid={usernameMissing || undefined}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            className={cn('h-8 bg-background text-xs', usernameMissing && 'border-destructive')}
            data-testid="login-save-username"
          />
          {usernameMissing && <p className="text-2xs text-destructive">Enter the username or email to save this account under</p>}
        </div>
      )}
      <SharedNotice otherMembers={otherMembers} site={site} />
    </div>
  )
}

/** Brand icons of the sign-in providers, by provider id; the black ones turn white in the dark theme. */
const PROVIDER_ICONS: Record<string, { slug: string; invert?: boolean }> = {
  google: { slug: 'google' },
  microsoft: { slug: 'microsoft' },
  'microsoft-work': { slug: 'microsoft' },
  apple: { slug: 'apple', invert: true },
  github: { slug: 'github', invert: true },
  facebook: { slug: 'facebook' },
  linkedin: { slug: 'linkedin' },
  x: { slug: 'twitter', invert: true },
  slack: { slug: 'slack' },
}

function ProviderIcon({ providerId, className }: { providerId: string; className?: string }) {
  const icon = PROVIDER_ICONS[providerId]
  if (!icon) return <KeyRound className={cn('text-muted-foreground', className)} />
  return <ServiceIcon slug={icon.slug} className={cn(icon.invert && 'dark:invert', className)} />
}

/** The user's saved accounts on sites that are no known provider: a company's own sign-in, say. */
function otherSavedAccounts(info: LoginVaultInfo): LoginVaultInfo['providerAccounts'] {
  return info.providerAccounts.filter((account) => account.providerId === null)
}

/** The ways to sign in through another account that the form offers. */
export interface ProviderChoices {
  /** The page's own buttons ("Sign in with Google"), in its order, as the agent listed them. */
  shown: LoginVaultInfo['providers']
  /** Every other provider: the agent may have missed a button, or it is on a later page. */
  more: LoginVaultInfo['providers']
  /** The user has saved accounts on other sites (a company's own sign-in). */
  otherSaved: boolean
}

export function providerChoices(info: LoginVaultInfo, site: string, pageProviders: readonly string[]): ProviderChoices {
  // Never the site itself: not GitHub on github.com's own sign-in page.
  const providers = info.providers.filter((provider) => provider.site !== site)
  const shown = [...new Set(pageProviders)].flatMap((id) => providers.filter((provider) => provider.id === id))
  return { shown, more: providers.filter((provider) => !shown.includes(provider)), otherSaved: otherSavedAccounts(info).length > 0 }
}

/** Picking one asks which account there (SignInViaPanel); null picks among the user's saved accounts on other sites. */
type PickProvider = (providerId: string | null) => void

/** One way in, as a row: a tile, its name, a chevron. */
function WayRow({ icon, title, subtitle, disabled, onClick, 'data-testid': testId }: {
  icon: ReactNode
  title: string
  subtitle?: string
  disabled: boolean
  onClick: () => void
  'data-testid'?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-3 px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50"
      data-testid={testId}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-foreground">{title}</span>
        {subtitle && <span className="block truncate text-2xs text-muted-foreground">{subtitle}</span>}
      </span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </button>
  )
}

const WAY_GROUP = 'divide-y divide-border overflow-hidden rounded-md border border-border bg-background'

/**
 * Every way in but the form, a step away from it: the page itself first,
 * then the password manager, then the providers (the page's own buttons
 * first) and the user's saved accounts on other sites.
 */
export function LoginWayList({ onPage, passwordManager, choices, disabled, onPick }: {
  /** Null on this app's own sign-in page: nothing may be typed there by hand. */
  onPage: (() => void) | null
  /** The connected password manager's logins for the page, when it fits. */
  passwordManager: ReactNode
  choices: ProviderChoices | null
  disabled: boolean
  onPick: PickProvider
}) {
  const providers = choices ? [...choices.shown, ...choices.more] : []
  const otherSaved = choices?.otherSaved === true
  return (
    <div className="space-y-3" data-testid="login-ways-group">
      {onPage && (
        <div className={WAY_GROUP}>
          <WayRow
            icon={<Globe className="h-3.5 w-3.5 text-muted-foreground" />}
            title="Sign in on the page instead"
            subtitle="Type it yourself in the browser view"
            disabled={disabled}
            onClick={onPage}
            data-testid="login-take-over"
          />
        </div>
      )}
      {passwordManager}
      {(providers.length > 0 || otherSaved) && (
        <div className="space-y-1.5" data-testid="login-via-providers">
          <p className="text-xs text-muted-foreground">Sign in with</p>
          <div className={WAY_GROUP}>
            {providers.map((provider) => (
              <WayRow
                key={provider.id}
                icon={<ProviderIcon providerId={provider.id} className="h-3.5 w-3.5" />}
                title={provider.name}
                disabled={disabled}
                onClick={() => onPick(provider.id)}
                data-testid={`login-via-provider-${provider.id}`}
              />
            ))}
            {otherSaved && (
              <WayRow
                icon={<KeyRound className="h-3.5 w-3.5 text-muted-foreground" />}
                title="Another saved account"
                disabled={disabled}
                onClick={() => onPick(null)}
                data-testid="login-via-saved"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Which account of the picked provider the user signs in to the site with:
 * a saved one, or one named. Without a provider, one of the user's saved
 * accounts on other sites. The agent clicks the provider's button itself and
 * is told which account to pick.
 */
export function SignInViaPanel({
  info,
  site,
  providerId,
  busy,
  error,
  onSignInVia,
  onBack,
}: {
  info: LoginVaultInfo | undefined
  site: string
  providerId: string | null
  busy: boolean
  error?: string
  onSignInVia: (provider: LoginViaProvider) => void
  onBack: () => void
}) {
  const [username, setUsername] = useState('')
  const provider = info?.providers.find((candidate) => candidate.id === providerId)
  const saved = !info ? [] : provider ? info.providerAccounts.filter((account) => account.providerId === provider.id) : otherSavedAccounts(info)
  return (
    <div className="space-y-3 pt-4" data-testid="login-via">
      <LoginStepBack onClick={onBack} disabled={busy} data-testid="login-via-back" />
      <p className="flex items-center gap-2 text-sm text-foreground">
        {provider && <ProviderIcon providerId={provider.id} className="h-4 w-4 shrink-0" />}
        {provider ? `Which ${provider.name} account do you sign in to ${site} with?` : `Which account do you sign in to ${site} with?`}
      </p>
      {saved.length > 0 && (
        <div className="space-y-1.5">
          {saved.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => onSignInVia({ accountId: account.id })}
              disabled={busy}
              className="flex w-full items-center gap-3 rounded-md border border-border bg-background px-2.5 py-2 text-left hover:bg-muted disabled:opacity-50"
              data-testid={`login-via-account-${account.id}`}
            >
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{account.username}</span>
                {!provider && <span className="block truncate text-2xs text-muted-foreground">{account.providerName}</span>}
              </span>
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      {provider ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (username.trim()) onSignInVia({ providerId: provider.id, username: username.trim() })
          }}
        >
          {saved.length > 0 && <div className="text-xs font-medium text-foreground">Or another account</div>}
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Email or username"
            aria-label={`Email or username of the ${provider.name} account`}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            className="h-9 bg-background text-xs"
            data-testid="login-via-username"
          />
          <SharedNotice otherMembers={info?.otherMembers ?? 0} site={site} />
          <p className="text-2xs text-muted-foreground">
            Saved to your vault for {site}. The agent clicks the site&apos;s {provider.name.replace(/ \(.*\)$/, '')} button and picks only this account.
          </p>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <LoginActionRow>
            <Button
              type="submit"
              size="sm"
              className={LOGIN_PRIMARY_BUTTON}
              loading={busy}
              disabled={busy || !username.trim()}
              data-testid="login-via-submit"
            >
              Continue
            </Button>
          </LoginActionRow>
        </form>
      ) : (
        <>
          <SharedNotice otherMembers={info?.otherMembers ?? 0} site={site} />
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        </>
      )}
    </div>
  )
}
