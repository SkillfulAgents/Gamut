import { createContext, useContext, type ReactNode } from 'react'
import { ArrowUpRight, Clock3, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { DialogDescription, DialogTitle } from '@renderer/components/ui/dialog'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { cn } from '@shared/lib/utils/cn'

/** The main button of a setup's footer, in brand blue as in Team Brain's set-up. */
export const SETUP_PRIMARY_BUTTON = 'bg-brand font-medium text-white hover:bg-brand/90'

/** A footer button that does more than move on: creating an app, connecting. */
export interface IntegrationSetupWizardAction {
  label: string
  busyLabel?: string
  busy?: boolean
  disabled?: boolean
  onClick: () => void
  testId?: string
  /** It opens another site or app (Slack, GitHub, Linear): the button shows the arrow that says so on hover. */
  external?: boolean
}

/** One screen of a setup: a single thing to do, and whatever it needs. */
export interface IntegrationSetupWizardStep {
  /** What to do, as a short instruction: the step's name in the rail. */
  label: string
  /** Shown above the instructions: something to decide before following them, such as a name. */
  lead?: ReactNode
  /** Where and how to do it. A place named here goes in `<strong>`. */
  subtitle?: ReactNode
  content?: ReactNode
  /** Stands in for Next (on the last step, for the finish button) when leaving the step does something. */
  action?: IntegrationSetupWizardAction
  /** A quiet action beside it, e.g. checking a token; the last step otherwise takes the wizard's `aside`. */
  aside?: IntegrationSetupWizardAside
  /** Another way to do the step, as a ghost button right before the main one, e.g. setting an app up by hand. */
  secondary?: IntegrationSetupWizardAction
  /** A short line at the start of the button row, for what follows from the step rather than what to fill in. */
  note?: ReactNode
}

/** "Set this up later", when the dialog offers it: saves the provider as a reminder and closes. */
export interface SetUpLater { busy: boolean; onClick: () => void }
/** Set by the setup dialog; the intro and the steps each put it in their own footer. */
export const SetUpLaterContext = createContext<SetUpLater | null>(null)

/** The quiet "Set this up later" button at the start of a footer. */
export function SetUpLaterButton({ later }: { later: SetUpLater }) {
  return <Button type="button" size="sm" variant="ghost" className="-ml-3 mr-auto text-muted-foreground" onClick={later.onClick} loading={later.busy}>
    {!later.busy && <Clock3 aria-hidden="true" />}Set this up later
  </Button>
}

/** A quiet footer action at the start of the row. */
export interface IntegrationSetupWizardAside { label: string; busyLabel?: string; busy?: boolean; disabled?: boolean; onClick: () => void }

/**
 * A provider's setup, one step at a time: the steps' names in a narrow rail
 * on the dialog's own surface (the ones before the current step ticked, the
 * ones after it grey, any of them clickable), the current step beside it.
 * Team Brain's set-up modal at the size of what a connection asks: the dialog
 * is only as large as the step in it.
 *
 * The caller holds the step, so it can move on when an action succeeds, or
 * send someone back to the step whose field is still empty.
 */
export function IntegrationSetupWizard({ provider, label, verb = 'Connect', heading, description, steps, step, onStepChange, feedback, finish, aside, testId }: {
  /** The provider's slug, for its mark at the top of the rail. */
  provider: string
  label: string
  /** The heading's first word, before the provider's name. */
  verb?: string
  /** The rail's heading, where "{verb} {label}" doesn't say it. */
  heading?: string
  /** What connecting gets you, read out with the heading. */
  description?: string
  steps: IntegrationSetupWizardStep[]
  step: number
  onStepChange: (step: number) => void
  feedback?: ReactNode
  /** The last step's button, unless that step has its own action. */
  finish?: IntegrationSetupWizardAction
  /** A quiet action at the footer's start on the last step, e.g. checking a token. */
  aside?: IntegrationSetupWizardAside
  testId?: string
}) {
  const index = Math.min(Math.max(step, 0), steps.length - 1)
  const current = steps[index]
  const last = index === steps.length - 1
  const action = current.action ?? (last ? finish : undefined)
  const quiet = current.aside ?? (last ? aside : undefined)
  const later = useContext(SetUpLaterContext)
  return (
    <div className="flex min-h-[26rem] w-[min(40rem,calc(100vw-2rem))]" data-testid={testId ?? 'integration-setup-wizard'}>
      {/* Dark in both themes, the provider's mark above the steps: the intro before it has already said what this is. */}
      <aside className="flex w-[13rem] shrink-0 flex-col justify-between gap-4 bg-[#1e1e1e] p-5 text-white max-sm:hidden dark:bg-black">
        <div>
          {/* The intro's tile, a size smaller: light on the dark rail, so marks drawn in black (GitHub, Linear) stay dark and none needs inverting.
              Pulled out by the steps' own -mx-2, so its left edge lines up with the current step's pill. */}
          <span aria-hidden="true" className="-ml-2 mb-5 flex h-9 w-9 items-center justify-center rounded-lg bg-white text-zinc-900 shadow-sm">
            <ServiceIcon slug={provider} fallback="mcp" className="h-5 w-5" />
          </span>
          <ol className="-mx-2 space-y-0.5" aria-label="Setup steps">
            {steps.map((s, i) => (
              <li key={s.label} aria-current={i === index ? 'step' : undefined}>
                <button type="button" onClick={() => onStepChange(i)} className={cn(
                  'flex min-h-8 w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                  // The current step in a filled brand-blue pill, as in Team Brain's set-up.
                  i === index ? 'bg-brand' : 'hover:bg-white/10',
                  i <= index ? 'text-white' : 'text-white/50',
                )}>
                  {/* Numbered 01, 02…, as in Team Brain's set-up modal; the label's colour says done, open or to come. */}
                  <span aria-hidden="true" className={cn('w-5 shrink-0 tabular-nums', i === index ? 'text-white' : 'text-white/40')}>{String(i + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 flex-1">{s.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        {/* At the foot of the rail, away from the step's own buttons. */}
        {later && (
          <button type="button" onClick={later.onClick} disabled={later.busy}
            className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white/50 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50">
            {/* The clock main's "Set this up later" has always had; a spinner while it saves. */}
            {later.busy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Clock3 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
            Set this up later
          </button>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col p-6" data-testid="integration-setup-step" data-step={index + 1}>
        {/* Named for screen readers; the intro showed it. */}
        <DialogTitle className="sr-only">{heading ?? `${verb} ${label}`}</DialogTitle>
        <DialogDescription className="sr-only">{description ? `${description} ` : ''}Step {index + 1} of {steps.length}: {current.label}</DialogDescription>
        <p className="mb-1.5 text-xs tabular-nums text-muted-foreground sm:hidden" aria-hidden="true">Step {index + 1} of {steps.length}</p>
        {/*
          Every step is laid out in the same grid cell, the ones not open hidden, so the
          flow is as tall as its tallest step and the dialog keeps one height as you move
          through it. A shorter step sits in the middle of that height. The even padding
          keeps the tallest clear of the close button.
        */}
        <div className="my-auto grid py-6">
          {steps.map((s, i) => {
            const open = i === index
            return (
              <div key={s.label} className={cn('col-start-1 row-start-1 self-center', open ? 'duration-300 animate-in fade-in motion-reduce:animate-none' : 'invisible')}
                aria-hidden={!open} {...(open ? {} : { inert: '' })}>
                {/* The rail names the step; this names it for screen readers, and the step leads with what to do. */}
                <h2 className="sr-only">{s.label}</h2>
                {s.lead && <div className={cn((s.subtitle || s.content || (open && feedback)) && 'pb-5')}>{s.lead}</div>}
                {s.subtitle && (
                  <p className="pr-8 text-sm text-muted-foreground [&_strong]:font-normal [&_strong]:text-foreground">{s.subtitle}</p>
                )}
                {(s.content || (open && feedback)) && <div className={cn('space-y-4', s.subtitle && 'pt-5')}>{s.content}{open && feedback}</div>}
              </div>
            )
          })}
        </div>
        <footer className="flex items-center justify-end gap-2">
          {current.note && <p className="mr-auto pr-4 text-xs text-muted-foreground">{current.note}</p>}
          {/* The rail holds it; a phone has no rail, so it comes down here, where the row's start is free. */}
          {later && !current.note && !quiet && <div className="mr-auto sm:hidden"><SetUpLaterButton later={later} /></div>}
          {quiet && (
            <Button type="button" size="sm" variant="ghost" className="-ml-3 mr-auto text-muted-foreground" onClick={quiet.onClick} disabled={quiet.disabled} loading={quiet.busy}>
              {quiet.busy ? quiet.busyLabel ?? quiet.label : quiet.label}
            </Button>
          )}
          {index > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onStepChange(index - 1)} data-testid="integration-setup-back">Back</Button>
          )}
          {current.secondary && (
            <Button type="button" size="sm" variant="ghost" onClick={current.secondary.onClick} disabled={current.secondary.disabled} loading={current.secondary.busy}
              data-testid={current.secondary.testId}>
              {current.secondary.busy ? current.secondary.busyLabel ?? current.secondary.label : current.secondary.label}
            </Button>
          )}
          {action ? (
            <Button type="button" size="sm" className={cn(SETUP_PRIMARY_BUTTON, action.external && EXTERNAL_BUTTON)} onClick={action.onClick} disabled={action.disabled} loading={action.busy}
              data-testid={action.testId ?? (last ? 'integration-setup-finish' : 'integration-setup-next')}>
              {action.busy ? action.busyLabel ?? action.label : action.label}
              {action.external && <ExternalArrow reveal />}
            </Button>
          ) : (
            <Button type="button" size="sm" className={SETUP_PRIMARY_BUTTON} onClick={() => onStepChange(index + 1)} data-testid="integration-setup-next">Next</Button>
          )}
        </footer>
      </section>
    </div>
  )
}

/** On a button whose `ExternalArrow` is revealed on hover: names the group the arrow listens to. */
export const EXTERNAL_BUTTON = 'group/external'

/**
 * The mark on a button or link that opens another site. On a button (`reveal`, inside `EXTERNAL_BUTTON`) it
 * slides out from the end of the label on hover or keyboard focus, and is always there on a touch screen,
 * which has no hover. In running text it is always there.
 */
export function ExternalArrow({ className, reveal }: { className?: string; reveal?: boolean }) {
  const arrow = <ArrowUpRight aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', className)} />
  if (!reveal) return arrow
  // Collapsed, the negative margin takes back the button's gap, so the label stays centred.
  return <span aria-hidden="true" className="-ml-1 inline-flex w-0 overflow-hidden opacity-0 transition-[width,margin,opacity] duration-150 ease-out group-hover/external:ml-0 group-hover/external:w-4 group-hover/external:opacity-100 group-focus-visible/external:ml-0 group-focus-visible/external:w-4 group-focus-visible/external:opacity-100 has-touch:ml-0 has-touch:w-4 has-touch:opacity-100 motion-reduce:transition-none">{arrow}</span>
}

/** A link to another site inside a step's text, with the arrow that says it leaves the app. */
export function IntegrationSetupWizardLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="inline-flex items-baseline gap-0.5 font-normal text-foreground underline decoration-foreground/30 underline-offset-[3px] transition-colors hover:decoration-foreground" href={href} target="_blank" rel="noopener noreferrer" onClick={event => {
    if (window.electronAPI) { event.preventDefault(); void window.electronAPI.openExternal(href) }
  }}>{children}<ExternalArrow className="h-3 w-3 self-center" /></a>
}
