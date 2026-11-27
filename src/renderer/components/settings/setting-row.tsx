import type { ReactNode } from 'react'
import { HelpCircle } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

export const SETTINGS_CARD_CLASS = 'rounded-card border border-border/60 bg-background divide-y divide-border/50 overflow-hidden'
export const SETTINGS_SECTION_HEADING = 'text-xs font-normal text-muted-foreground/80 px-1'

interface SettingFieldProps {
  /** Says what the setting does without a second line: "Auto-Delete Inactive Sessions", not "Session Auto-Delete" plus a sentence. */
  name: string
  /**
   * The label drawn in place of `name`, when it is more than plain text (a sentence with keycaps in it).
   * `name` still says what the row is, for the help icon's own label.
   */
  label?: ReactNode
  /**
   * What the label can't carry (a caveat, a requirement, what a named feature is),
   * shown in a tooltip behind a help icon after the label. Most rows need none:
   * reword the label before reaching for this.
   */
  help?: ReactNode
  /** Live state or data worth a glance (an update's progress, a plan's details), never a description of the setting. */
  status?: ReactNode
  right: ReactNode
  htmlFor?: string
  /** Stack the control under the label below `md`, for wide controls (text inputs) that would otherwise crush the label. */
  stack?: boolean
}

/** A setting's label and control, without a row's padding: for a field inside a card that pads itself. */
export function SettingField({ name, label: customLabel, help, status, right, htmlFor, stack }: SettingFieldProps) {
  const Name = htmlFor ? 'label' : 'div'
  const label = (
    <Name htmlFor={htmlFor} className="text-xs font-normal truncate block cursor-default">
      {customLabel ?? name}
    </Name>
  )
  return (
    <div className={cn('flex gap-3', stack ? 'flex-col items-stretch md:flex-row md:items-center' : 'items-center')}>
      <div className="min-w-0 flex-1">
        {help ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              {/* The label and the icon are one hover target, only as wide as the two of them.
                  The icon stays a button so the keyboard can reach the tooltip, and stays
                  outside the label so a click on it does not toggle the row's switch. */}
              <TooltipTrigger asChild>
                <div className="group/help flex w-fit max-w-full items-center gap-1.5">
                  {label}
                  <button
                    type="button"
                    aria-label={`About ${name}`}
                    className="inline-flex shrink-0 rounded-full text-muted-foreground/40 group-hover/help:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-60">{help}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : label}
        {status && <div className="text-[11px] text-muted-foreground mt-0.5">{status}</div>}
      </div>
      <div className={cn('flex items-center gap-2 shrink-0', stack && 'w-full md:w-auto')}>{right}</div>
    </div>
  )
}

interface SettingRowProps extends SettingFieldProps {
  /** Shown under the row while it applies: a warning, an error, a hint about the control's current state. */
  children?: ReactNode
}

/** A settings card's row: a self-explanatory label on the left, its control on the right. */
export function SettingRow({ children, ...field }: SettingRowProps) {
  return (
    <div className="py-3 px-4">
      <SettingField {...field} />
      {children}
    </div>
  )
}
