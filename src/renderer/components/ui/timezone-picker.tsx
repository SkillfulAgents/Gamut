import * as React from 'react'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import { PickerTrigger, type PickerVariant } from '@renderer/components/ui/picker-trigger'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { cn } from '@shared/lib/utils'

function getUtcOffset(tz: string): string {
  try {
    const now = new Date()
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    }).formatToParts(now)
    const offsetPart = parts.find((p) => p.type === 'timeZoneName')
    return offsetPart?.value ?? ''
  } catch {
    return ''
  }
}

interface TimezoneEntry {
  value: string
  label: string
  offset: string
}

let _cachedTimezones: TimezoneEntry[] | null = null

function getTimezones(): TimezoneEntry[] {
  if (_cachedTimezones) return _cachedTimezones
  _cachedTimezones = Intl.supportedValuesOf('timeZone').map((tz) => ({
    value: tz,
    label: tz.replace(/_/g, ' '),
    offset: getUtcOffset(tz),
  }))
  return _cachedTimezones
}

interface TimezonePickerProps {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  className?: string
  variant?: PickerVariant
}

export function TimezonePicker({ value, onValueChange, disabled, className, variant = 'outline' }: TimezonePickerProps) {
  const row = variant === 'row'
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')

  const timezones = getTimezones()
  const selectedEntry = timezones.find((tz) => tz.value === value)

  const filtered = React.useMemo(() => {
    if (!search) return timezones
    const lower = search.toLowerCase()
    return timezones.filter(
      (tz) =>
        tz.label.toLowerCase().includes(lower) ||
        tz.offset.toLowerCase().includes(lower) ||
        tz.value.toLowerCase().includes(lower)
    )
  }, [search, timezones])

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch('') }} modal>
      <PopoverTrigger asChild>
        <PickerTrigger
          variant={variant}
          outlineSize="default"
          outlineIcon={<ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
          role="combobox"
          aria-label="Select timezone"
          aria-expanded={open}
          disabled={disabled}
          className={cn(!row && 'w-full justify-between font-normal', className)}
        >
          <span className="truncate">
            {selectedEntry
              ? `${selectedEntry.label} (${selectedEntry.offset})`
              : 'Select timezone...'}
          </span>
        </PickerTrigger>
      </PopoverTrigger>
      <PopoverContent
        // The row trigger hugs its value, so the list takes a width of its own and opens from the trigger's right edge.
        className={cn('p-0 overflow-hidden', row ? 'w-80' : 'w-[var(--radix-popover-trigger-width)]')}
        align={row ? 'end' : 'start'}
        collisionPadding={8}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex items-center border-b px-3 py-2">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <input
            placeholder="Search timezone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        <div className="max-h-60 overflow-y-auto overscroll-contain p-1" data-testid="timezone-options">
          {filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              No timezone found.
            </div>
          )}
          {filtered.map((tz) => (
            <button
              key={tz.value}
              onClick={() => {
                onValueChange(tz.value)
                setOpen(false)
                setSearch('')
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-item px-2 py-1.5 text-sm cursor-pointer hover:bg-accent hover:text-accent-foreground',
                value === tz.value && 'bg-accent'
              )}
            >
              <Check
                className={cn('h-4 w-4 shrink-0', value === tz.value ? 'opacity-100' : 'opacity-0')}
              />
              <span className="flex-1 text-left truncate">{tz.label}</span>
              <span className="text-xs text-muted-foreground shrink-0">{tz.offset}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
