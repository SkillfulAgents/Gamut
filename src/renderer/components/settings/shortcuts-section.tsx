import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { getPlatform } from '@renderer/lib/env'
import { Kbd } from '@renderer/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  DEFAULT_GLOBAL_DISPATCH_SHORTCUT,
  acceleratorKeys,
  eventToAccelerator,
  formatAccelerator,
} from '@shared/lib/config/shortcuts'
import { toast } from 'sonner'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'

/** A key of the shortcut at the row's size: a step up from the chip a hint line uses. */
const KEYCAP = 'h-6 min-w-6 px-1.5 text-xs'

/**
 * The "Shortcuts" section of General settings (Electron-only). Currently just
 * the quick-dispatch launcher's global accelerator: an enable/disable toggle
 * plus a key-recorder. Empty accelerator = disabled.
 */
export function ShortcutsSection() {
  const { data: settings } = useSettings()
  const updateSettings = useUpdateSettings()
  const platform = getPlatform() ?? ''

  const current = settings?.app?.globalDispatchShortcut ?? DEFAULT_GLOBAL_DISPATCH_SHORTCUT
  const enabled = current !== ''
  const [recording, setRecording] = useState(false)
  // Modifiers held down while recording, as accelerator tokens.
  const [held, setHeld] = useState<string[]>([])
  const fieldRef = useRef<HTMLDivElement>(null)

  // Remember the last enabled accelerator so flipping the toggle back on
  // restores it (the empty-string "disabled" state can't carry it). Falls back
  // to the default when the launcher starts out disabled.
  const lastEnabledRef = useRef(enabled ? current : DEFAULT_GLOBAL_DISPATCH_SHORTCUT)
  if (enabled) lastEnabledRef.current = current

  // Register the accelerator with the main process FIRST (the authoritative
  // gate — it rejects conflicts), then persist it only if registration stuck,
  // so the saved value always matches what's actually bound.
  const applyShortcut = useCallback(
    async (accel: string) => {
      const result = await window.electronAPI?.setGlobalDispatchShortcut?.(accel)
      if (result && !result.success) {
        toast.error('Could not set shortcut', { description: result.error })
        return
      }
      try {
        await updateSettings.mutateAsync({ app: { globalDispatchShortcut: accel } })
        toast.success(accel === '' ? 'Launcher disabled' : 'Shortcut updated')
      } catch {
        toast.error('Failed to save shortcut')
      }
    },
    [updateSettings],
  )

  const handleToggle = useCallback(
    (next: boolean) => {
      if (recording) setRecording(false)
      void applyShortcut(next ? lastEnabledRef.current || DEFAULT_GLOBAL_DISPATCH_SHORTCUT : '')
    },
    [applyShortcut, recording],
  )

  // While recording, capture the next valid combo (Esc cancels), and show the
  // modifiers held so far so the field answers each key as it goes down.
  useEffect(() => {
    if (!recording) return
    const modifiersOf = (e: KeyboardEvent) => [
      ...(e.ctrlKey ? ['Control'] : []),
      ...(e.metaKey ? [platform === 'darwin' ? 'Command' : 'Super'] : []),
      ...(e.altKey ? ['Alt'] : []),
      ...(e.shiftKey ? ['Shift'] : []),
    ]
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      setHeld(modifiersOf(e))
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return // wait for a real key
      const accel = eventToAccelerator(e, platform)
      if (!accel) return
      setRecording(false)
      void applyShortcut(accel)
    }
    const onKeyUp = (e: KeyboardEvent) => setHeld(modifiersOf(e))
    // A key released while another window has focus never reports its keyup.
    const onBlur = () => setHeld([])
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [recording, platform, applyShortcut])

  // Forget the held modifiers when listening ends. Its own effect, keyed on `recording` alone: the listeners above
  // re-attach on every render (the mutation's identity changes), and clearing there would wipe the keys mid-press.
  useEffect(() => {
    if (!recording) setHeld((keys) => (keys.length > 0 ? [] : keys))
  }, [recording])

  const modifierNames = acceleratorKeys(
    ['Control', 'Alt', 'Shift', platform === 'darwin' ? 'Command' : 'Super'].join('+'),
    platform,
  )

  return (
    <div className="space-y-2">
      <h3 className={SETTINGS_SECTION_HEADING}>Shortcuts</h3>
      <div className={SETTINGS_CARD_CLASS}>
        <SettingRow
          name="Quick Dispatch launcher"
          help="A floating box you can open from anywhere on your computer to send an agent a task."
          right={
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              aria-label="Enable Quick Dispatch launcher"
              data-testid="dispatch-shortcut-toggle"
            />
          }
        />
        {/* Its shortcut is a setting of its own, shown only while the launcher is on. */}
        {enabled && (
          <SettingRow
            name="Launcher shortcut"
            // The row says what to do, with the keys in the sentence: "Press ⌃ + ⇧ + Space to launch".
            label={
              <span
                className="flex items-center gap-1.5"
                aria-label={`Press ${formatAccelerator(current, platform)} to launch`}
                data-testid="dispatch-shortcut-keys"
              >
                <span>Press</span>
                {acceleratorKeys(current, platform).map((key, index) => (
                  <Fragment key={key}>
                    {index > 0 && <span className="text-muted-foreground" aria-hidden="true">+</span>}
                    <Kbd className={KEYCAP}>{key}</Kbd>
                  </Fragment>
                ))}
                <span>to launch</span>
              </span>
            }
            right={
              // Recording happens in a popover off the button, so the row itself never changes shape. Open means
              // listening; closing it any way (Esc, a click outside, Cancel) stops without storing anything.
              <Popover open={recording} onOpenChange={setRecording}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="soft"
                    size="sm"
                    data-testid="dispatch-shortcut-record"
                  >
                    Customize
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  className="w-72 space-y-3 p-3"
                  // Focus the listening field, not a button: a Space or Enter in the shortcut must not press one.
                  onOpenAutoFocus={(event) => {
                    event.preventDefault()
                    fieldRef.current?.focus()
                  }}
                >
                  <div className="text-xs">Press the new shortcut</div>
                  {/* The field that is listening: it shows each modifier as it goes down. */}
                  <div
                    ref={fieldRef}
                    tabIndex={-1}
                    role="status"
                    className="flex h-9 items-center gap-1 rounded-control border border-ring bg-background px-2 outline-none ring-2 ring-ring/20"
                    data-testid="dispatch-shortcut-recording"
                  >
                    {acceleratorKeys(held.join('+'), platform).map((key) => (
                      <Kbd key={key} className={KEYCAP}>{key}</Kbd>
                    ))}
                    <span className="text-[11px] text-muted-foreground">
                      {held.length > 0 ? 'then a key…' : 'Waiting for keys…'}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Hold {modifierNames.slice(0, -1).join(', ')} or {modifierNames.at(-1)}, then press a key.
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    {current !== DEFAULT_GLOBAL_DISPATCH_SHORTCUT ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-ml-2 font-normal text-muted-foreground"
                        onClick={() => {
                          setRecording(false)
                          void applyShortcut(DEFAULT_GLOBAL_DISPATCH_SHORTCUT)
                        }}
                      >
                        Reset to default
                      </Button>
                    ) : <span />}
                    <Button type="button" variant="ghost" size="sm" className="font-normal" onClick={() => setRecording(false)}>
                      Cancel
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            }
          />
        )}
      </div>
    </div>
  )
}
