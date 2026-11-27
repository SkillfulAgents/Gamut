import type { LucideIcon } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@shared/lib/utils/cn'

export interface SegmentedOption<T extends string> {
  value: T
  /** The segment's text, or the tooltip of a segment drawn as an icon. */
  label: string
  /** Draws the segment as this icon alone, with `label` as its tooltip. */
  icon?: LucideIcon
  /** The segment's accessible name when `label` alone would not say enough ("Light theme"). */
  ariaLabel?: string
}

interface SegmentedControlProps<T extends string> {
  /** Names the group: what is being chosen. */
  'aria-label': string
  value: T
  options: readonly SegmentedOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}

const SEGMENT =
  'inline-flex h-7 items-center justify-center rounded-control font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50'

/**
 * A single choice among a few, drawn as one pill with the chosen segment lifted: the Appearance picker's look,
 * and an On/Off switch where a row's own switch would be lost (a page title's row).
 *
 * A radiogroup, intentionally not Radix Tabs: there are no tab panels, so a TabsTrigger's aria-controls would
 * dangle (a critical aria-valid-attr-value violation).
 */
export function SegmentedControl<T extends string>({
  'aria-label': ariaLabel,
  value,
  options,
  onChange,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  return (
    <TooltipProvider delayDuration={0}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className={cn('inline-flex h-8 items-center justify-center rounded-control bg-muted p-0.5 text-muted-foreground', className)}
      >
        {options.map((option) => {
          const selected = option.value === value
          const Icon = option.icon
          const segment = (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.ariaLabel ?? (Icon ? option.label : undefined)}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                SEGMENT,
                Icon ? 'w-8 text-sm' : 'min-w-9 px-2.5 text-xs',
                selected && 'bg-background text-foreground shadow',
              )}
            >
              {Icon ? <Icon className="h-3.5 w-3.5" /> : option.label}
            </button>
          )
          // Text says what it is; an icon needs its name on hover.
          if (!Icon) return segment
          return (
            <Tooltip key={option.value}>
              <TooltipTrigger asChild>{segment}</TooltipTrigger>
              <TooltipContent>{option.label}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </TooltipProvider>
  )
}
