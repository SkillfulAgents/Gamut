import { useEffect, useRef, useState } from 'react'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'

const UNSET = 'unset'
const CUSTOM = 'custom'

interface PresetNumberSelectProps {
  /** The trigger's id, so the row's label names it. */
  id: string
  /** Names the custom number field, which the row's label does not point at. */
  label: string
  /** The stored number, or undefined when none is set. */
  value: number | undefined
  /** What "none set" means here: "Unlimited", "Default (32,000)". */
  unsetLabel: string
  /** Suggested values, ascending. */
  presets: readonly number[]
  format?: (value: number) => string
  /** The smallest number the custom field accepts; anything lower is raised to it. */
  min: number
  step?: number
  /** Whole numbers unless the setting takes fractions (a cost). */
  fractional?: boolean
  /** Shown in the empty custom field: the unit, when the label does not give it ("Minutes"). */
  placeholder?: string
  onChange: (value: number | undefined) => void
  disabled?: boolean
}

/**
 * A settings row's number: a row dropdown of suggested values, with "Custom…" opening a number field beside it
 * for anything else. The field is there only while a custom number is being typed: once stored, the number reads
 * as the row's value like any suggested one, and sits in the list as an option of its own.
 */
export function PresetNumberSelect({
  id,
  label,
  value,
  unsetLabel,
  presets,
  format = (n) => n.toLocaleString(),
  min,
  step,
  fractional = false,
  placeholder,
  onChange,
  disabled,
}: PresetNumberSelectProps) {
  // True from picking "Custom…" until the number typed is stored or given up.
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusFieldOnClose = useRef(false)

  // A stored number off the list is an option too, in its place among the suggestions.
  const options = value === undefined || presets.includes(value)
    ? presets
    : [...presets, value].sort((a, b) => a - b)

  // The field only goes away when it loses focus, so make sure it has it: an unfocused field would sit in the row.
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const stopEditing = () => {
    setDraft(null)
    setEditing(false)
  }

  const commit = () => {
    const raw = draft
    stopEditing()
    if (raw === null || raw.trim() === '') return
    const parsed = fractional ? parseFloat(raw) : parseInt(raw, 10)
    if (Number.isNaN(parsed)) return
    const next = Math.max(min, parsed)
    if (next !== value) onChange(next)
  }

  return (
    <>
      {editing && (
        <Input
          ref={inputRef}
          type="number"
          min={min}
          step={step}
          aria-label={`Custom ${label}`}
          placeholder={placeholder}
          value={draft ?? (value !== undefined ? String(value) : '')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            // Escape gives the typed number up; the stored one stays.
            if (e.key === 'Escape') {
              e.stopPropagation()
              stopEditing()
            }
          }}
          className="h-8 w-24 text-xs"
          disabled={disabled}
          data-testid={`${id}-custom`}
        />
      )}
      <Select
        variant="row"
        value={editing ? CUSTOM : value === undefined ? UNSET : String(value)}
        onValueChange={(next) => {
          setDraft(null)
          if (next === CUSTOM) {
            focusFieldOnClose.current = true
            setEditing(true)
            return
          }
          setEditing(false)
          onChange(next === UNSET ? undefined : Number(next))
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          // After "Custom…", the cursor belongs in the field it just opened, not back on the trigger.
          onCloseAutoFocus={(event) => {
            if (!focusFieldOnClose.current) return
            focusFieldOnClose.current = false
            event.preventDefault()
            inputRef.current?.focus()
          }}
        >
          <SelectItem value={UNSET}>{unsetLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={String(option)}>{format(option)}</SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
    </>
  )
}
