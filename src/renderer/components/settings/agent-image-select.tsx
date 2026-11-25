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

const DEFAULT = '__default__'
const CUSTOM = '__custom__'

interface AgentImageSelectProps {
  /** The trigger's id, so the row's label names it. */
  id: string
  /** The image in the form, as typed: the caller trims it when saving. */
  value: string
  /** The image a new install uses. */
  defaultImage: string
  onChange: (image: string) => void
  disabled?: boolean
}

/**
 * The agent image as a row dropdown: Default, or a custom image. "Custom…" opens a field beside it, there only
 * while an image is being typed (and while it is blank, so the row's "required" message has its field). A stored
 * custom image then reads as the row's value, like any other.
 */
export function AgentImageSelect({ id, value, defaultImage, onChange, disabled }: AgentImageSelectProps) {
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const focusFieldOnClose = useRef(false)
  // What Escape goes back to.
  const before = useRef(value)

  const trimmed = value.trim()
  const isDefault = trimmed === defaultImage
  const blank = trimmed.length === 0
  // A blank image cannot be left behind a closed dropdown: keep its field up.
  const showField = !disabled && (editing || blank)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  return (
    <>
      {showField && (
        <Input
          ref={inputRef}
          aria-label="Custom agent image"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              e.stopPropagation()
              onChange(before.current)
              setEditing(false)
            }
          }}
          placeholder={defaultImage}
          className="h-8 w-full font-mono text-xs md:w-[280px]"
          data-testid={`${id}-custom`}
        />
      )}
      <Select
        variant="row"
        value={showField ? CUSTOM : isDefault ? DEFAULT : trimmed}
        onValueChange={(next) => {
          if (next === CUSTOM) {
            before.current = value
            focusFieldOnClose.current = true
            setEditing(true)
            return
          }
          setEditing(false)
          onChange(next === DEFAULT ? defaultImage : next)
        }}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="max-w-[320px]">
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
          <SelectItem value={DEFAULT}>Default</SelectItem>
          {!isDefault && !blank && (
            <SelectItem value={trimmed}>
              <span className="font-mono">{trimmed}</span>
            </SelectItem>
          )}
          <SelectSeparator />
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
    </>
  )
}
