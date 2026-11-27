import * as React from 'react'
import { Slot, Slottable } from '@radix-ui/react-slot'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@shared/lib/utils'
import { Button } from './button'

export type PickerVariant = 'outline' | 'row'

interface PickerTriggerProps extends React.ComponentPropsWithoutRef<'button'> {
  variant?: PickerVariant
  /** Supply a primitive that already renders its own trigger button, such as Radix Select. */
  asChild?: boolean
  outlineSize?: 'sm' | 'default'
  outlineIcon?: React.ReactNode
}

export const PickerTrigger = React.forwardRef<HTMLButtonElement, PickerTriggerProps>(function PickerTrigger({
  variant = 'outline', asChild, outlineSize = 'sm', outlineIcon, className, children, ...props
}, ref) {
  const row = variant === 'row'
  const trigger = asChild ? children : (
    <Button variant={row ? 'ghost' : 'outline'} size={row ? 'sm' : outlineSize}>{children}</Button>
  )

  return (
    <Slot
      ref={ref}
      className={cn(
        // The negative margin puts the chevron on the row's padding edge. The value takes a settings row label's size;
        // the agent side panel, whose labels are a step larger, passes its own.
        row
          ? '-mr-1 h-8 gap-1 px-1 text-xs font-normal text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground/70'
          : !asChild && outlineSize === 'sm' && 'h-[34px] gap-1.5 px-2 text-xs font-medium',
        className,
      )}
      {...props}
    >
      <Slottable>{trigger}</Slottable>
      {row
        ? <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground/50" />
        : outlineIcon ?? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />}
    </Slot>
  )
})
