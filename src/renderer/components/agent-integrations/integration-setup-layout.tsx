import type { ComponentProps, ReactNode } from 'react'
import { AlertCircle, CheckCircle, ChevronRight, HelpCircle, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@shared/lib/utils/cn'
import { Label } from '@renderer/components/ui/label'
import { Switch } from '@renderer/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Textarea } from '@renderer/components/ui/textarea'

// The pieces a setup's steps are made of. The frame they sit in is `IntegrationSetupWizard`.

/** An optional extra with its own button, e.g. an icon to download. */
export function IntegrationSetupAside({ action, children }: { action: ReactNode; children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
    <p className="min-w-0 flex-1 basis-56 text-xs leading-relaxed text-muted-foreground [&_strong]:font-normal [&_strong]:text-foreground">{children}</p>
    {action}
  </div>
}

/** A step's instructions as numbered parts, each short enough to follow at a glance. Falsy entries are skipped. */
export function IntegrationSetupList({ items }: { items: ReactNode[] }) {
  return <ol className="space-y-3">
    {items.filter(item => item !== null && item !== undefined && item !== false).map((item, i) => (
      <li key={i} className="flex gap-3 text-sm">
        <span aria-hidden="true" className="w-3 shrink-0 tabular-nums text-muted-foreground">{i + 1}.</span>
        <div className="min-w-0 flex-1">{item}</div>
      </li>
    ))}
  </ol>
}

/**
 * Settings almost no one needs, folded under "Advanced". Closed, its fields stay mounted and keep their values.
 * It follows the settings box: tucked up close under it and lined up with the labels inside it. `flush` is for
 * a step with no box, where it lines up with the step's text instead.
 */
export function IntegrationSetupAdvanced({ children, flush }: { children: ReactNode; flush?: boolean }) {
  return <details className={cn('group text-xs', !flush && '-mt-2 pl-3.5')} data-testid="integration-setup-advanced">
    <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
      Advanced<ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
    </summary>
    <div className="space-y-4 pt-3">{children}</div>
  </details>
}

/**
 * A few choices in one card, a row each and each a single line, so all of them can be read without opening
 * anything. What the chosen one needs or shows (`details`) opens under its own row and shares its tint, so the
 * two read as one thing.
 */
export function IntegrationSetupChoices<T extends string>({ options, value, onChange, disabled = false, details, labelledBy, label, testId }: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T; onChange: (value: T) => void; disabled?: boolean
  /** For the chosen row only. */
  details?: ReactNode
  /** The id of the text that asks the question, or `label` where nothing on screen does. */
  labelledBy?: string
  label?: string
  testId?: (value: T) => string
}) {
  return <div role="radiogroup" aria-labelledby={labelledBy} aria-label={label} className="divide-y overflow-hidden rounded-item border">
    {options.map(option => {
      const on = option.value === value
      return <div key={option.value} className={cn('transition-colors', on ? 'bg-muted/40' : 'bg-background')}>
        <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange(option.value)} data-testid={testId?.(option.value)}
          className={cn('flex h-10 w-full items-center gap-3 px-3.5 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
            !on && !disabled && 'hover:bg-muted/40')}>
          <span aria-hidden="true" className={cn('grid size-4 shrink-0 place-items-center rounded-full border bg-background transition-colors', on ? 'border-foreground' : 'border-foreground/30')}>
            {on && <span className="size-2 rounded-full bg-foreground" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
        </button>
        {/* Under the label, not the dot, so it belongs to the line above it. */}
        {on && details && <div className="pb-3 pl-[2.625rem] pr-3.5 text-xs text-muted-foreground" aria-live="polite">{details}</div>}
      </div>
    })}
  </div>
}

/**
 * What a setting does, a hover or a tab away behind a question mark, so its row stays one line. It goes beside
 * the setting's label, not in it: a click here shouldn't flip the switch.
 */
export function IntegrationSetupHelp({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return <TooltipProvider>
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={`About “${label}”`} data-testid={testId}
          className="inline-flex shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-60">{children}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
}

/**
 * One on/off choice in a step, e.g. whether an app uses webhooks: its name on the left, with what it changes
 * behind a help icon, and a switch on the right, like the rows in a setup's settings box.
 */
export function IntegrationSetupToggle({ id, label, description, checked, onCheckedChange, disabled, testId, className }: {
  id: string; label: string; description?: string; className?: string
  checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean; testId?: string
}) {
  return <div className={cn('flex items-center justify-between gap-4 text-xs', className)}>
    <div className="flex min-w-0 items-center gap-1.5">
      <Label htmlFor={id} className="cursor-pointer text-xs font-normal">{label}</Label>
      {description && <IntegrationSetupHelp label={label} testId={`${id}-help`}>{description}</IntegrationSetupHelp>}
      {/* The tooltip is only in the page while it's open; this is what a screen reader reads with the switch. */}
      {description && <span id={`${id}-description`} className="sr-only">{description}</span>}
    </div>
    {/* The settings cards' switch size, so it sits with 11px text. */}
    <Switch id={id} className="origin-right scale-75" checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-describedby={description ? `${id}-description` : undefined} data-testid={testId} />
  </div>
}

/** A quiet line under the steps: what happens next, or a limit worth knowing. */
export function IntegrationSetupNote({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
}

/**
 * A few things worth knowing before going on, a line each: a tinted panel with no border, like a step's preview,
 * so it reads as an aside and not as something to fill in.
 */
export function IntegrationSetupCallout({ title, items }: { title: string; items: ReactNode[] }) {
  return <div className="rounded-xl bg-muted/70 px-4 py-3.5 text-xs dark:bg-muted/40" data-testid="integration-setup-callout">
    <p className="text-[11px] text-muted-foreground">{title}</p>
    <ul className="mt-2 space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5 leading-relaxed">
          <span aria-hidden="true" className="mt-[0.55em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
          <span className="min-w-0 flex-1">{item}</span>
        </li>
      ))}
    </ul>
  </div>
}

/** Inline code in a step: a command to send or a scope to pick. */
export function IntegrationSetupCode({ children }: { children: ReactNode }) {
  return <code className="bg-muted text-foreground px-1 py-0.5 rounded font-mono text-[0.9em]">{children}</code>
}

export function IntegrationSetupField({ label, optional, id, action, hideLabel, hint, ...props }: ComponentProps<typeof Input> & {
  label: string; id: string; optional?: boolean
  /** A line under the field: what it's for, or when to leave it empty. */
  hint?: ReactNode
  /** A button inside the field's end, e.g. checking what was pasted. */
  action?: { label: string; busyLabel?: string; busy?: boolean; disabled?: boolean; onClick: () => void }
  /** Read out but not drawn, where the text just above already says it, e.g. a numbered instruction. */
  hideLabel?: boolean
}) {
  return <div>
    <Label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-xs font-normal'}>
      {label}{optional && <span className="ml-1 text-muted-foreground/70">optional</span>}
    </Label>
    <div className={cn('relative', !hideLabel && 'mt-1.5')}>
      <Input {...props} id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={cn('shadow-none bg-background', action && 'pr-20')} />
      {action && <Button type="button" size="xs" variant="ghost" onClick={action.onClick} disabled={action.disabled} loading={action.busy}
        className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        {action.busy ? action.busyLabel ?? action.label : action.label}
      </Button>}
    </div>
    {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
  </div>
}

export function IntegrationSetupTextArea({ label, optional, id, hideLabel, ...props }: ComponentProps<typeof Textarea> & {
  label: string; id: string; optional?: boolean
  /** Read out but not drawn, where the text just above already says it. */
  hideLabel?: boolean
}) {
  return <div>
    <Label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-xs font-normal'}>
      {label}{optional && <span className="ml-1 text-muted-foreground/70">optional</span>}
    </Label>
    <Textarea {...props} id={id} className={cn('shadow-none bg-background', !hideLabel && 'mt-1.5')} />
  </div>
}

export function IntegrationSetupFeedback({ state, children }: { state: 'error' | 'success' | 'pending'; children: ReactNode }) {
  const Icon = state === 'error' ? AlertCircle : state === 'success' ? CheckCircle : Loader2
  const colors = state === 'error' ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950 dark:text-red-400'
    : state === 'success' ? 'border-green-200 bg-green-50 text-green-600 dark:border-green-900 dark:bg-green-950 dark:text-green-400'
      : 'border-border bg-background text-muted-foreground'
  return <div role={state === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2 p-2 rounded-item border text-xs ${colors}`}>
    <Icon className={`h-4 w-4 shrink-0 ${state === 'pending' ? 'animate-spin' : ''}`} />
    <div>{children}</div>
  </div>
}
