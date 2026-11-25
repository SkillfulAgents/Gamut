import type { ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

/** One key, drawn as a small chip. A shortcut is a row of these, one per key. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border/60 bg-muted px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
