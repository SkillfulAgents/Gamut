import { useEffect, useRef } from 'react'
import { KeyRound, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@shared/lib/utils/cn'
import { RequestItemShell } from '../requests/request-item-shell'
import type { LoginFieldSummary, LoginVaultPayload, LoginWay } from './login-request'
import { siteLabel } from './login-request'
import { LoginForm, LoginSiteHeading } from './login-form'
import { LoginWays } from './login-ways'
import { loginRequestKey, useLoginRequestState, type LoginKept } from './login-request-store'
import { useLoginContext, useLoginRequestActions } from './use-login-request'

interface LoginRequestItemProps {
  toolUseId: string
  message: string
  fields: LoginFieldSummary[]
  /** A page that asks how to verify it's you: its ways, as the agent mapped them. */
  ways?: LoginWay[]
  vault?: LoginVaultPayload
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

const STATUS_LABELS = {
  filled: 'Sent to the page',
  fill_unconfirmed: 'Saved for the agent',
  via: 'Signs in with another account',
  way: 'Way picked',
  manual: 'Signed in on the page',
  declined: 'Declined',
  settled: 'Already answered',
} as const

/** The browser had closed before the user answered. */
function browserClosedLabel(kept: LoginKept | null): string {
  if (!kept) return 'The browser had closed'
  return kept.how === 'saved' ? 'Saved for the agent' : 'Kept for the agent'
}

/** The picked account's saved session went in instead of its values. */
function sessionLabel(restored: boolean): string {
  return restored ? 'Signed in with the saved session' : 'The saved session did not restore'
}

export function LoginRequestItem({
  toolUseId,
  message,
  fields,
  ways,
  vault,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: LoginRequestItemProps) {
  const state = useLoginRequestState(loginRequestKey(agentSlug, sessionId, toolUseId))
  const { decline } = useLoginRequestActions({ agentSlug, sessionId, toolUseId })
  // Viewers who cannot answer do not read the form's context (they may not).
  const context = useLoginContext(agentSlug, sessionId, toolUseId, !readOnly)
  const origin = context.data?.origin ?? null
  const done = state.status === 'filled' || state.status === 'via' || state.status === 'way' || state.status === 'manual' || state.status === 'declined' ||
    state.status === 'settled' || state.status === 'browser_closed' || state.status === 'fill_unconfirmed' || state.status === 'session'
  // Here, not in the form: the shell swaps the form for its completed row in
  // the same render that settles the request, so the form never sees it.
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  useEffect(() => {
    if (done) onCompleteRef.current()
  }, [done])
  // The card leaves the stack as the request settles, so what went wrong in
  // the page is said where it outlives the card.
  const result = state.status === 'filled' ? state.result : null
  const saveError = state.status === 'browser_closed' ? state.saveError : result?.saveError
  useEffect(() => {
    if (saveError) toast.error(saveError)
  }, [saveError])
  useEffect(() => {
    if (!result) return
    if (result.filled === 0 || result.problems.length > 0) {
      const problems = result.problems.join(' ') || 'The agent has been told what the page showed.'
      const title = result.filled > 0 ? 'Not everything went into the page'
        : result.outcomes?.includes('unconfirmed') ? 'The browser did not confirm the fill' : 'Nothing was filled on the page'
      toast.warning(title, {
        description: result.saved ? `${result.saved.username} is saved. ${problems}` : problems,
      })
    }
  }, [result])
  const unconfirmedAccount = state.status === 'fill_unconfirmed' ? state.username : null
  useEffect(() => {
    if (unconfirmedAccount) toast.success(`${unconfirmedAccount} is saved`, {
      description: 'The browser did not confirm the fill. The agent was asked to check the page and reopen it if needed.',
    })
  }, [unconfirmedAccount])
  const wayProblems = state.status === 'way' ? state.problems : null
  useEffect(() => {
    if (wayProblems?.length) toast.warning('The way was not clicked', { description: `${wayProblems.join(' ')} The agent has been told.` })
  }, [wayProblems])
  const sessionFailed = state.status === 'session' && !state.restored
  useEffect(() => {
    if (sessionFailed) toast.warning('The saved session did not restore', { description: 'Nothing was filled. The agent has been told what the page showed.' })
  }, [sessionFailed])
  const closedKept = state.status === 'browser_closed' ? state.kept : undefined
  useEffect(() => {
    if (closedKept === undefined) return
    if (!closedKept) {
      toast.warning('The browser had closed', { description: 'Nothing went into the page, and nothing was kept. The agent opens it again and asks you.' })
      return
    }
    const closed = 'The browser had closed, so nothing went into the page.'
    const who = closedKept.username ?? 'Your sign-in'
    if (closedKept.how === 'saved') toast.success(`${who} is saved`, { description: `${closed} The agent opens it again and signs in with this.` })
    else if (closedKept.how === 'held') toast.success(`${who} is kept for the agent`, { description: `${closed} The agent opens it again and, within 30 minutes, signs in with what you entered.` })
    else toast.success(`The agent can sign in as ${who}`, { description: `${closed} The agent opens it again and signs in with this account.` })
  }, [closedKept])

  return (
    <RequestItemShell
      // The site comes from the browser, never from the agent: it is the
      // one thing a person must read before typing a password.
      title={origin ? `Sign in to ${siteLabel(origin)}` : 'Sign in'}
      // Under the title, the address the values go to. The agent's own words
      // are only for a viewer who cannot answer: the form is the rest.
      subtitle={readOnly ? message : <LoginSiteHeading context={context.data ?? null} />}
      theme="blue"
      // Declining ends the agent's turn too, so the X declines: one click, no menu.
      close={(
        <button
          type="button"
          onClick={() => void decline()}
          disabled={state.status === 'submitting'}
          aria-label="Decline"
          title="Decline"
          data-testid="login-decline"
          className="inline-flex h-5 w-5 items-center justify-center rounded-control text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      waitingText="Waiting for sign-in"
      completed={
        done
          ? {
              icon: (
                <KeyRound
                  className={cn('h-4 w-4 shrink-0', state.status === 'declined' ? 'text-red-500' : 'text-green-500')}
                />
              ),
              label: <span className="text-sm">{origin ? siteLabel(origin) : 'Sign in'}</span>,
              statusLabel: state.status === 'browser_closed'
                ? browserClosedLabel(state.kept)
                : state.status === 'session' ? sessionLabel(state.restored) : STATUS_LABELS[state.status],
              isSuccess: state.status === 'browser_closed'
                ? state.kept !== null
                : state.status === 'session' ? state.restored : state.status !== 'declined',
            }
          : null
      }
      readOnly={readOnly ? {} : false}
      data-testid={done ? 'login-request-completed' : 'login-request'}
      data-status={done ? state.status : undefined}
    >
      {!readOnly && (context.data ? context.data.ways.length > 0 : (ways?.length ?? 0) > 0) ? (
        context.data
          ? <LoginWays agentSlug={agentSlug} sessionId={sessionId} toolUseId={toolUseId} context={context.data} />
          : <div className="mt-4 h-[4.5rem] animate-pulse rounded-md bg-muted/50" data-testid="login-loading" />
      ) : !readOnly && (
        <LoginForm
          agentSlug={agentSlug}
          sessionId={sessionId}
          toolUseId={toolUseId}
          fields={fields}
          vault={vault}
          autoFocus
        />
      )}
    </RequestItemShell>
  )
}
