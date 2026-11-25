import { forwardRef, useEffect, useId, useRef, useState, type ComponentProps } from 'react'
import { Eye, EyeOff, KeyRound, MousePointerClick, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { isElectron } from '@renderer/lib/env'
import { cn } from '@shared/lib/utils/cn'
import { BrowserCredentialPicker } from '../request-browser-input/browser-credential-picker'
import { partKeyOf } from '@shared/lib/browser-vault/vault-schemas'
import {
  compactLoginCode,
  isInsecureOrigin,
  loginFillResultSchema,
  siteLabel,
  type LoginContext,
  type LoginContextField,
  type LoginFieldKind,
  type LoginFieldSummary,
  type LoginVaultPayload,
  type VaultOffer,
} from './login-request'
import { loginRequestKey, recallLoginValues, setLoginRequestState } from './login-request-store'
import { AccountChooser, AddSignInMethodBox, LoginWayList, providerChoices, SaveDetails, SaveToggle, SignInViaPanel } from './login-vault-sections'
import { LOGIN_PRIMARY_BUTTON, LoginActionRow, LoginStepBack, OtherWaysLink } from './login-parts'
import { interruptedFillState, LoginContextUnavailable, useLoginContext, useLoginRequestActions, useLoginVaultInfo } from './use-login-request'

interface LoginFormProps {
  agentSlug: string
  sessionId: string
  toolUseId: string
  /** The agent's fields, drawn (disabled) until the browser has located them. */
  fields: LoginFieldSummary[]
  /** How the host left the request: a named account, or a saved one that lacks some of what the page asks. */
  vault?: LoginVaultPayload
  autoFocus?: boolean
}

/** What each kind is, in the app's words, for a field whose label the agent chose. */
const KIND_WORDS: Record<LoginFieldKind, string> = {
  username: 'username',
  password: 'password',
  otp: 'code',
  text: 'other',
}

/**
 * Keeps password managers from filing what is typed here under this app's
 * origin — these are another site's credentials, and the app's origin hosts
 * every site's form. Saved logins come from the host's password manager.
 */
const NOT_FOR_PASSWORD_MANAGERS = {
  autoComplete: 'off',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
  'data-form-type': 'other',
  'data-lpignore': 'true',
} as const

/** Input attributes for a field: the keyboard, and what the OS may offer. */
function inputAttributes(field: Pick<LoginContextField, 'kind' | 'inputType' | 'inputMode'>): ComponentProps<'input'> {
  switch (field.kind) {
    case 'username': {
      // Plain text: an "email or phone" field must take a phone number, so no
      // native email validation — the email keyboard is enough.
      const inputMode = field.inputType === 'email' ? 'email' : field.inputType === 'tel' ? 'tel' : undefined
      return { type: 'text', inputMode, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, ...NOT_FOR_PASSWORD_MANAGERS }
    }
    case 'otp': {
      const numeric = field.inputMode === 'numeric' || field.inputType === 'tel' || field.inputType === 'number'
      // one-time-code lets iOS and Android offer the code from an SMS.
      return { type: 'text', inputMode: numeric ? 'numeric' : 'text', autoComplete: 'one-time-code', autoCorrect: 'off', spellCheck: false }
    }
    default:
      return { type: 'text', autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false, ...NOT_FOR_PASSWORD_MANAGERS }
  }
}

/**
 * A masked input. In the desktop app it is a password input: Electron has no
 * password manager, and a password input stays masked to screen readers, OS
 * accessibility and keyboards too. In a browser it is a text input masked
 * on screen only — a password input there would be offered the app's own
 * saved password, which is not for this site.
 */
// Forwards its ref: a form whose first field is a password focuses it.
const SecretInput = forwardRef<HTMLInputElement, ComponentProps<typeof Input> & { label: string }>(function SecretInput({ className, label, ...props }, ref) {
  const [show, setShow] = useState(false)
  const passwordInput = isElectron()
  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        type={passwordInput && !show ? 'password' : 'text'}
        className={cn('pr-10', !passwordInput && !show && '[-webkit-text-security:disc]', className)}
      />
      <button
        type="button"
        onClick={() => setShow((value) => !value)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
        aria-label={`Show ${label}`}
        aria-pressed={show}
        disabled={props.disabled}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  )
})

/** What the agent can see of the values, and where they go: two short lines. */
function privacyNote(site: string, kinds: LoginFieldKind[]): [string, string] {
  const hidden = [
    kinds.includes('password') && 'password',
    kinds.includes('otp') && 'code',
    kinds.includes('text') && 'other fields',
  ].filter(Boolean) as string[]
  const list = hidden.length > 1 ? `${hidden.slice(0, -1).join(', ')} and ${hidden[hidden.length - 1]}` : hidden[0]
  return [hidden.length ? `The agent never sees the ${list}.` : 'The agent can see the username.', `Only filled on ${site}.`]
}

/**
 * What goes in a field, in the app's words for the common kinds: the page's
 * label is the agent's to choose, so it names only the kinds the app cannot.
 */
function fieldLabel(field: Pick<LoginContextField, 'kind' | 'label'> & { inputType?: string }): string {
  if (field.kind === 'username') return field.inputType === 'tel' ? 'Phone number' : 'Email or username'
  if (field.kind === 'password') return 'Password'
  return field.label
}

/** What an empty field says once Sign in is clicked. */
function missingText(field: Pick<LoginContextField, 'kind' | 'label'> & { inputType?: string }): string {
  if (field.kind === 'username') return field.inputType === 'tel' ? 'Enter your phone number' : 'Enter your email or username'
  if (field.kind === 'password') return 'Enter your password'
  return `Enter ${field.label.toLowerCase()}`
}

/**
 * The site the values go to, as the browser reported it: the card's
 * subtitle, under the title that names the host. A warning only when there is
 * one (plain HTTP, a frame). Spans only: it sits in the shell's subtitle line.
 * Hosts wrap rather than truncate: the end of a hostname names the site.
 */
export function LoginSiteHeading({ context, className }: { context: Pick<LoginContext, 'origin' | 'topOrigin'> | null; className?: string }) {
  const origin = context?.origin ?? null
  const insecure = origin !== null && isInsecureOrigin(origin)
  const framed = context && context.topOrigin !== context.origin
  return (
    <span className={cn('flex min-w-0 items-start gap-1 text-xs text-muted-foreground', className)} data-testid="login-site">
      {insecure && <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" aria-hidden />}
      {origin ? (
        <span className="min-w-0 break-all">
          <span data-testid="login-origin">{origin}</span>
          {insecure && <span className="block text-amber-700 dark:text-amber-400" data-testid="login-insecure">Not encrypted (http): what you enter can be read on the network.</span>}
          {framed && <span className="block" data-testid="login-framed">In a frame on {siteLabel(context.topOrigin)}</span>}
        </span>
      ) : (
        <span>Locating the sign-in form on the page…</span>
      )}
    </span>
  )
}

/**
 * Which located fields a saved account fills: its username, and the parts it
 * holds — unless they may not go into this page (saved on https, the page on
 * plain HTTP), where the user types them. One that signs in through another
 * account fills no password.
 */
function coveredBy(offer: Pick<VaultOffer, 'parts' | 'via' | 'fillsHere'>, fields: LoginContext['fields']): Set<number> {
  const covered = new Set<number>()
  fields.forEach((field, index) => {
    if (field.kind === 'username') covered.add(index)
    const part = partKeyOf(field)
    if (part && offer.fillsHere !== false && offer.parts.includes(part) && !(offer.via && part === 'password')) covered.add(index)
  })
  return covered
}

/** Why the agent is asking again, when it is a retry: in the app's words, and the agent's own beneath. */
function retryNote(vault: LoginVaultPayload | undefined): { text: string; agentSays?: string } | null {
  if (!vault || vault.mode !== 'ask') return null
  const whose = vault.username ? ` for ${vault.username}` : ''
  if (vault.reason) return { text: 'The agent says the sign-in did not go through:', agentSays: vault.reason }
  if (vault.rejectedAt) return { text: `The site turned down the saved password${whose} on ${new Date(vault.rejectedAt).toLocaleDateString()}. Enter the current one to update it.` }
  if (vault.filledAt) {
    const at = new Date(vault.filledAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return { text: `The saved password${whose} already went in at ${at}, and the agent is signing in again. If it was wrong, enter the current one.` }
  }
  return null
}

/** The user signs in in the browser view themselves, then says so. */
export function SignInOnPage({
  origin,
  error,
  busy,
  finishing,
  onBack,
  onDone,
}: {
  origin: string | null
  error?: string
  busy: boolean
  finishing: boolean
  onBack: () => void
  onDone: () => void
}) {
  return (
    <>
      <LoginStepBack onClick={onBack} disabled={busy} data-testid="login-back-to-form" />
      <div className="flex items-start gap-2 rounded-md bg-muted/50 p-3 text-sm text-foreground">
        <MousePointerClick className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <span>
          Sign in directly in the browser view{origin ? ` on ${siteLabel(origin)}` : ''}, then click Done.
          {' '}What you type on the page itself is not hidden from the agent.
        </span>
      </div>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <LoginActionRow>
        <Button
          size="sm"
          className={LOGIN_PRIMARY_BUTTON}
          onClick={onDone}
          loading={finishing}
          disabled={busy}
          data-testid="login-manual-done"
        >
          Done
        </Button>
      </LoginActionRow>
    </>
  )
}

/** A saved account filling part of the form: the one the host left the request for, or one the user picked. */
interface FormAccount {
  id?: string
  username?: string
  covered: Set<number>
}

export function LoginForm({
  agentSlug,
  sessionId,
  toolUseId,
  fields: summaryFields,
  vault,
  autoFocus = false,
}: LoginFormProps) {
  const formId = useId()
  const errorId = `${formId}-error`
  const context = useLoginContext(agentSlug, sessionId, toolUseId)
  const { state, fill, signInVia, requestMethod, completeManually } = useLoginRequestActions({ agentSlug, sessionId, toolUseId })
  // The form, or a step a click away from it: the other ways in, signing in
  // on the page, or through another account.
  const [mode, setMode] = useState<'form' | 'ways' | 'manual' | 'via'>('form')
  // Sign in was clicked with something missing: each empty field says so until it has a value.
  const [showMissing, setShowMissing] = useState(false)
  // The provider picked under "Or sign in with"; null for a saved account on another site.
  const [viaProvider, setViaProvider] = useState<string | null>(null)
  const [values, setValues] = useState<string[]>([])
  const [heldValues, setHeldValues] = useState<string[]>([])
  const [picked, setPicked] = useState<(VaultOffer & { covered: Set<number> }) | null>(null)
  // Two steps when the user has saved accounts here: choose one, or go on to
  // the fields for another. The agent asking for the form (a retry, an
  // account it named, another account) opens on the fields.
  const [differentAccount, setDifferentAccount] = useState(() => vault?.mode === 'ask')
  // The saved account a click is signing in with, while it runs.
  const [usingOffer, setUsingOffer] = useState<(VaultOffer & { covered: Set<number> }) | null>(null)
  const [saveChoice, setSaveChoice] = useState<boolean | null>(null)
  const [saveUsername, setSaveUsername] = useState('')
  // What the server said the saved account could not fill after all: those
  // fields are asked for, and a saved account that is gone fills nothing.
  const [needed, setNeeded] = useState<ReadonlySet<number>>(new Set())
  const [accountGone, setAccountGone] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const located: LoginContext | undefined = context.data
  const unavailable = context.error instanceof LoginContextUnavailable ? context.error : null
  const vaultInfo = useLoginVaultInfo(agentSlug, sessionId, toolUseId, located !== undefined && !unavailable)
  const info = vaultInfo.data
  const site = info?.site ?? (located ? siteLabel(located.origin) : '')
  const otherMembers = info?.otherMembers ?? 0
  const choices = located && !unavailable && info ? providerChoices(info, site, located.providers) : null
  const pickProvider = (providerId: string | null) => {
    setViaProvider(providerId)
    setMode('via')
  }
  // On by default; on an agent other members use, an explicit choice (it shares the account).
  const save = saveChoice ?? otherMembers === 0

  // Prefill the identifier: the account the agent named, else this window's
  // memory of the last attempt.
  useEffect(() => {
    if (!located) return
    setValues((current) => {
      if (current.some(Boolean)) return current
      const recalled = recallLoginValues(agentSlug, sessionId, located.origin, located.fields)
      return vault?.username ? located.fields.map((field, index) => (field.kind === 'username' ? vault.username ?? '' : recalled[index])) : recalled
    })
  }, [agentSlug, sessionId, located, vault?.username])

  const busy = state.status === 'submitting'
  const running = state.status === 'submitting' ? state.action : null
  const error = state.status === 'idle' ? state.error : undefined
  const recovery = state.status === 'idle' ? state.recovery : undefined
  const refetchVault = vaultInfo.refetch
  useEffect(() => {
    if (recovery?.reason === 'fields_needed') {
      setNeeded((current) => new Set([...current, ...recovery.fields]))
      // An account used in one click lacked them after all: just those are asked for, as that account.
      setPicked((current) => current ?? usingOffer)
    }
    if (recovery?.reason === 'account_unavailable') {
      setAccountGone(true)
      setPicked(null)
      // Gone, or no longer the user's: the fields, and the saved accounts as they are now.
      setDifferentAccount(true)
      void refetchVault()
    }
  }, [recovery, usingOffer, refetchVault])
  const fields: Array<LoginFieldSummary & Partial<LoginContextField>> = located?.fields ?? summaryFields
  const held = located?.held ?? []
  const account: FormAccount | null = picked
    ? { id: picked.id, username: picked.username, covered: picked.covered }
    : vault?.mode === 'complete' && !accountGone
      ? { id: vault.accountId, username: vault.username, covered: new Set(vault.covered ?? []) }
      : null
  const fillsField = (index: number) => account?.covered.has(index) === true && !needed.has(index)
  const retry = retryNote(vault)
  const shown = fields.flatMap((field, index) => (fillsField(index) ? [] : [{ field, index }]))
  const secret = fields.some((field) => field.kind === 'password' || field.kind === 'otp')
  const complete = located !== undefined && located.fields.length > 0 && shown.every(({ index }) => (values[index] ?? '').length > 0)
  const stillLocating = !located && !unavailable && context.failureCount > 1
  const usernameIndex = fields.findIndex((field) => field.kind === 'username')
  const identity = account?.username ||
    (usernameIndex >= 0 ? values[usernameIndex]?.trim() : '') ||
    vault?.username ||
    info?.identity ||
    null
  const askUsername = usernameIndex < 0 && !account?.username && !vault?.username && !info?.identity
  // Something here would land in the vault: an account (its username), or a part of one.
  const savable = held.length > 0 || shown.some(({ field }) => field.kind === 'username' || partKeyOf(field) !== null)
  const canSave = located !== undefined && located.fields.length > 0 && info !== undefined && !unavailable && savable
  // A saved login holds an identifier and a password: offered only when that
  // is all the page asks for. It goes straight into the page, never the form.
  const savedLoginFits = located !== undefined && located.fields.length > 0 && !account &&
    located.fields.every((field) => field.kind === 'username' || field.kind === 'password')
  // The saved accounts that do something on this step: fill a field, or sign
  // in through a provider (not on a code step). Not one that fills nothing.
  const codeStep = located !== undefined && located.fields.length > 0 && located.fields.every((field) => field.kind === 'otp')
  const offers = located && !account && vault?.mode !== 'complete'
    ? (info?.accounts ?? []).filter((offer) => coveredBy(offer, located.fields).size > 0 || (Boolean(offer.via?.id) && !codeStep))
    : []
  // The step on screen. Nothing until the browser has located the fields and
  // the user's saved accounts are known, since one of those may be the
  // answer; then the choice among them, when there are any; else the fields.
  const loading = !unavailable && (!located || !(vaultInfo.isSuccess || vaultInfo.isError))
  const choosing = !loading && offers.length > 0 && !differentAccount
  const fieldsStep = !loading && !choosing

  // Focus the first field once the fields are on screen: after the wait
  // above, and after the user went on from the saved accounts. The browser
  // can take a while, so only when focus is nowhere else — never pull it from
  // the composer mid-sentence.
  const focusFields = useRef(false)
  useEffect(() => {
    if (!fieldsStep || (!autoFocus && !focusFields.current)) return
    focusFields.current = false
    const active = document.activeElement
    if (!active || active === document.body || rootRef.current?.contains(active)) firstFieldRef.current?.focus()
  }, [autoFocus, fieldsStep])

  const fillOptions = (accountId?: string, granting = false) => ({
    ...(held.length && heldValues.some(Boolean) ? { heldValues: held.map((_, index) => heldValues[index] ?? '') } : {}),
    ...(canSave && save
      ? { save: true, ...(askUsername && saveUsername.trim() ? { username: saveUsername.trim() } : {}) }
      : {}),
    ...(accountId ? { accountId } : {}),
    // The notice was on screen where the user chose to save or to use a saved account.
    ...(otherMembers > 0 && ((canSave && save) || granting) ? { sharedAgentAcknowledged: true } : {}),
  })

  // Sign in is never greyed out for what is missing: the empty fields say what they need, and the first takes focus.
  const submit = () => {
    if (!located || busy) return
    if (!complete || (canSave && save && askUsername && !saveUsername.trim())) {
      setShowMissing(true)
      const firstEmpty = shown.find(({ index }) => !(values[index] ?? '').length)
      if (firstEmpty) rootRef.current?.querySelector<HTMLInputElement>(`[data-testid="login-field-${firstEmpty.index}"]`)?.focus()
      return
    }
    const sent = located.fields.map((_, index) => (fillsField(index) ? '' : values[index] ?? ''))
    void fill(located, sent, fillOptions(account?.id, picked !== null && !picked.granted))
  }

  /** One click: an account that fills every field goes straight in; another is picked, and the rest is typed. */
  const useOffer = (offer: VaultOffer) => {
    if (!located || busy) return
    // What the server said another account could not fill says nothing about this one.
    setNeeded(new Set())
    const covered = coveredBy(offer, located.fields)
    // It signs in through another account: there is nothing to type here
    // (unless the step asks only for what it holds besides, a workspace);
    // the agent is told which provider account to pick.
    if (offer.via?.id && (located.fields.length === 0 || covered.size < located.fields.length)) {
      setUsingOffer({ ...offer, covered })
      void signInVia(located, { accountId: offer.via.id }, otherMembers > 0)
      return
    }
    if (covered.size === located.fields.length) {
      setUsingOffer({ ...offer, covered })
      void fill(located, located.fields.map(() => ''), {
        accountId: offer.id,
        ...(otherMembers > 0 && !offer.granted ? { sharedAgentAcknowledged: true } : {}),
      })
      return
    }
    focusFields.current = true
    setPicked({ ...offer, covered })
    setValues(located.fields.map((field, index) => (field.kind === 'username' ? offer.username : covered.has(index) ? '' : values[index] ?? '')))
  }

  const pickWay = (providerId: string | null) => {
    setShowMissing(false)
    pickProvider(providerId)
  }
  // Every way in but the form. Not the page for this app's own sign-in:
  // typing the app's password there by hand would sign the agent's browser in to it.
  const onPage = unavailable?.forThisApp ? null : () => setMode('manual')
  const passwordManager = savedLoginFits ? (
    <BrowserCredentialPicker
      agentSlug={agentSlug}
      sessionId={sessionId}
      toolUseId={toolUseId}
      kind="login"
      disabled={busy}
      // "Save" covers a login from the password manager too: the whole login goes to the vault.
      loginOptions={canSave && save
        ? { save: true, ...(otherMembers > 0 ? { sharedAgentAcknowledged: true } : {}) }
        : undefined}
      onFilled={(body) => {
        const key = loginRequestKey(agentSlug, sessionId, toolUseId)
        // Answered in another window first: nothing was filled from here.
        if ((body as { alreadySettled?: unknown } | null)?.alreadySettled === true) {
          setLoginRequestState(key, { status: 'settled' })
          return
        }
        const interrupted = interruptedFillState(body)
        if (interrupted) {
          setLoginRequestState(key, interrupted)
          return
        }
        const parsed = loginFillResultSchema.safeParse(body)
        setLoginRequestState(key, parsed.success
          ? { status: 'filled', result: parsed.data }
          : { status: 'idle', error: 'The saved login was sent, but the answer could not be read. Check the browser view.' })
      }}
    />
  ) : null
  const wayList = (
    <LoginWayList
      onPage={onPage}
      passwordManager={passwordManager}
      choices={choices}
      disabled={busy}
      onPick={pickWay}
    />
  )
  const hasOtherWays = onPage !== null || passwordManager !== null ||
    (choices !== null && (choices.shown.length > 0 || choices.more.length > 0 || choices.otherSaved))
  const otherWays = hasOtherWays && <OtherWaysLink onClick={() => { setShowMissing(false); setMode('ways') }} disabled={busy} />

  if (mode === 'manual') {
    return (
      <div ref={rootRef} className="space-y-3 pt-4" data-testid="login-manual">
        <SignInOnPage
          origin={located?.origin ?? null}
          error={error}
          busy={busy}
          finishing={running === 'manual'}
          onBack={() => setMode('form')}
          onDone={() => void completeManually()}
        />
      </div>
    )
  }

  if (mode === 'via' && located) {
    return (
      <div ref={rootRef}>
        <SignInViaPanel
          info={info}
          site={site}
          providerId={viaProvider}
          busy={busy}
          error={error}
          onSignInVia={(provider) => void signInVia(located, provider, otherMembers > 0)}
          onBack={() => setMode('ways')}
        />
      </div>
    )
  }

  if (mode === 'ways') {
    return (
      <div ref={rootRef} className="space-y-3 pt-4" data-testid="login-ways-list">
        <LoginStepBack onClick={() => setMode('form')} disabled={busy} data-testid="login-ways-back" />
        {wayList}
        {error && <p className="text-xs text-destructive" role="alert" data-testid="login-error">{error}</p>}
      </div>
    )
  }

  const retryBlock = retry && (
    <p className="rounded-md bg-amber-500/10 px-2.5 py-2 text-xs text-foreground" data-testid="login-retry-note">
      {retry.text}
      {retry.agentSays && <span className="mt-0.5 block break-words italic text-muted-foreground">{retry.agentSays}</span>}
    </p>
  )

  // Waiting for the browser and the vault, or the choice among the user's saved accounts.
  if (!fieldsStep) {
    return (
      <div ref={rootRef} className="space-y-3 pt-4">
        {retryBlock}
        {loading ? (
          <div className="h-[4.5rem] animate-pulse rounded-md bg-muted/50" data-testid="login-loading" />
        ) : (
          <AccountChooser
            offers={offers}
            site={site}
            otherMembers={otherMembers}
            disabled={busy}
            pendingId={running === 'fill' || running === 'via' ? usingOffer?.id ?? null : null}
            onUse={useOffer}
            onDifferent={() => {
              focusFields.current = true
              setDifferentAccount(true)
            }}
          />
        )}
        {stillLocating && (
          <p className="text-xs text-muted-foreground" data-testid="login-still-locating">
            Still waiting for the browser to locate the form…
            {' '}
            <button type="button" className="underline" onClick={() => void context.refetch()}>Try again</button>
          </p>
        )}
        {error && <p className="text-xs text-destructive" role="alert" data-testid="login-error">{error}</p>}
        {!loading && otherWays && <LoginActionRow>{otherWays}</LoginActionRow>}
      </div>
    )
  }

  // A page that offers only "Continue with …": its ways are the step.
  const noFields = located !== undefined && located.fields.length === 0

  return (
    <div ref={rootRef} className="space-y-3 pt-4">
      {differentAccount && offers.length > 0 && (
        <LoginStepBack
          onClick={() => {
            setShowMissing(false)
            setDifferentAccount(false)
          }}
          disabled={busy}
          label="Saved accounts"
          data-testid="login-back-to-accounts"
        />
      )}

      {retryBlock}

      {account?.username && (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 px-2.5 py-2 text-xs text-foreground" data-testid="login-vault-account">
          <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            Signing in as <span className="break-all font-medium">{account.username}</span>
            {account.covered.size > (usernameIndex >= 0 && account.covered.has(usernameIndex) ? 1 : 0) && (
              <span className="block text-2xs text-muted-foreground">The saved account fills the rest; enter what it does not have.</span>
            )}
          </span>
          {picked && (
            <button
              type="button"
              className="shrink-0 text-2xs text-muted-foreground underline"
              onClick={() => {
                setPicked(null)
                setNeeded(new Set())
              }}
              disabled={busy}
              data-testid="login-vault-account-clear"
            >
              Use another
            </button>
          )}
        </div>
      )}

      {/* Only the fields sit inside the <form>: the other controls are plain
          <button>s, and inside it the first would be the default button
          Enter presses. */}
      <form
        id={formId}
        className="space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
        data-testid="login-form"
      >
        {unavailable ? (
          <div className="rounded-md bg-muted/50 p-3 text-xs text-foreground" data-testid="login-unavailable">
            <p>The fields the agent picked could not be used, so nothing will be sent from this form.</p>
            {unavailable.problems.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-muted-foreground">
                {unavailable.problems.map((problem, index) => <li key={index}>{problem}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            {shown.map(({ field, index }) => {
              const inputId = `${formId}-field-${index}`
              const missingId = `${inputId}-missing`
              const missing = showMissing && !(values[index] ?? '').length
              const attributes = inputAttributes({ kind: field.kind, inputType: field.inputType ?? '', inputMode: field.inputMode ?? '' })
              const label = fieldLabel(field)
              const common = {
                ...attributes,
                id: inputId,
                ref: index === shown[0]?.index ? firstFieldRef : undefined,
                name: `${field.kind}-${index}`,
                value: values[index] ?? '',
                disabled: !located || busy,
                // A code's limit applies once its separators are gone: a pasted
                // "123 456" would otherwise lose its last digit to a limit of 6.
                maxLength: field.kind !== 'otp' && field.maxLength && field.maxLength > 1 ? field.maxLength : undefined,
                'aria-invalid': missing || undefined,
                'aria-describedby': [missing && missingId, error && errorId].filter(Boolean).join(' ') || undefined,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                  const typed = event.target.value
                  const next = field.kind === 'otp'
                    ? compactLoginCode(typed, { inputType: field.inputType ?? '', inputMode: field.inputMode ?? '', maxLength: field.maxLength ?? -1 })
                    : typed
                  setValues((current) => {
                    const copy = [...current]
                    copy[index] = next
                    return copy
                  })
                },
                className: cn('bg-background', missing && 'border-destructive'),
                'data-testid': `login-field-${index}`,
                'data-kind': field.kind,
              }
              return (
                <div key={index} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={inputId} className="block min-w-0 truncate text-xs text-muted-foreground">{label}</label>
                    {/* Under a label the agent chose, what kind it is, so it cannot pass for another. */}
                    {(field.kind === 'otp' || field.kind === 'text') && (
                      <span className="shrink-0 text-2xs text-muted-foreground/70" data-testid={`login-field-kind-${index}`}>{KIND_WORDS[field.kind]}</span>
                    )}
                  </div>
                  {field.kind === 'password' || field.kind === 'text' ? <SecretInput {...common} label={label} /> : <Input {...common} />}
                  {missing && <p id={missingId} className="text-2xs text-destructive" data-testid={`login-field-missing-${index}`}>{missingText(field)}</p>}
                </div>
              )
            })}
            {held.length > 0 && (
              <div className="space-y-2.5 pt-1" data-testid="login-held">
                <p className="text-2xs text-muted-foreground">For the next step: filled when {site} asks for it. Optional.</p>
                {held.map((field, index) => {
                  const inputId = `${formId}-held-${index}`
                  return (
                    <div key={index} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <label htmlFor={inputId} className="block min-w-0 truncate text-xs text-muted-foreground">{field.label}</label>
                        <span className="shrink-0 text-2xs text-muted-foreground/70">{KIND_WORDS[field.kind]}, next step</span>
                      </div>
                      <SecretInput
                        {...inputAttributes({ kind: field.kind, inputType: '', inputMode: '' })}
                        id={inputId}
                        name={`held-${field.kind}-${index}`}
                        label={field.label}
                        value={heldValues[index] ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const typed = event.target.value
                          setHeldValues((current) => {
                            const copy = [...current]
                            copy[index] = typed
                            return copy
                          })
                        }}
                        className="bg-background"
                        data-testid={`login-held-field-${index}`}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {error && <p id={errorId} className="text-xs text-destructive" role="alert" data-testid="login-error">{error}</p>}
      </form>

      {/* Under the fields: it speaks for them. */}
      {located && !unavailable && located.fields.length > 0 && (
        <p className="flex items-start gap-1.5 text-2xs text-muted-foreground" data-testid="login-privacy">
          <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{privacyNote(siteLabel(located.origin), [...located.fields, ...held].map((field) => field.kind)).join(' ')}</span>
        </p>
      )}

      {/* A code is a step of two-step verification: the moment to offer an app that makes the next one. */}
      {codeStep && info?.addMethod && <AddSignInMethodBox addMethod={info.addMethod} onRequest={requestMethod} disabled={busy} />}

      {canSave && save && (
        <SaveDetails
          askUsername={askUsername}
          usernameValue={saveUsername}
          onUsernameChange={setSaveUsername}
          usernameMissing={showMissing && !saveUsername.trim()}
          otherMembers={otherMembers}
          site={site}
          disabled={busy}
        />
      )}

      {noFields ? wayList : (
        // Saving on the left; the other ways, then Sign in, on the right.
        <LoginActionRow
          start={canSave && (
            <SaveToggle checked={save} onCheckedChange={setSaveChoice} site={site} username={identity} disabled={busy} />
          )}
        >
          {otherWays}
          <Button
            type="submit"
            form={formId}
            size="sm"
            className={LOGIN_PRIMARY_BUTTON}
            loading={running === 'fill'}
            disabled={busy || !located || !!unavailable}
            data-testid="login-submit"
          >
            {secret ? 'Submit' : 'Continue'}
          </Button>
        </LoginActionRow>
      )}
    </div>
  )
}
