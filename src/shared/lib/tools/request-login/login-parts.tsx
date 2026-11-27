import type { ReactNode } from 'react'
import { ChevronDown, ChevronLeft } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

/** The sign-in card's shared controls, the same on every step. */

/** Every step's one primary button, at the bottom right: the card's only bright control. */
export const LOGIN_PRIMARY_BUTTON = 'min-w-24 bg-blue-600 text-white hover:bg-blue-700'

/** The card's last row: what sits with the buttons on the left, the buttons on the right. Wraps when narrow. */
export function LoginActionRow({ start, children }: { start?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-1">
      {start}
      <div className="ml-auto flex items-center gap-1">{children}</div>
    </div>
  )
}

/** Back a step: from a way in to the form, from the fields to the saved accounts. */
export function LoginStepBack({ onClick, disabled, label = 'Back', 'data-testid': testId }: { onClick: () => void; disabled?: boolean; label?: string; 'data-testid'?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="-mt-1 flex items-center gap-0.5 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
      data-testid={testId}
    >
      <ChevronLeft className="h-3 w-3" />
      {label}
    </button>
  )
}

/** Beside the primary button: the ways in other than the form, a step away. A ghost, quiet beside Sign in. */
export function OtherWaysLink({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      className="gap-1 font-normal text-muted-foreground"
      data-testid="login-other-ways"
    >
      Other ways to sign in
      <ChevronDown className="h-3 w-3" />
    </Button>
  )
}
