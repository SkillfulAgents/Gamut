import { useCallback, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { SegmentedControl, type SegmentedOption } from '@renderer/components/ui/segmented-control'
import { TimezonePicker } from '@renderer/components/ui/timezone-picker'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { useUpdateStatus } from '@renderer/context/update-status-context'
import { ShortcutsSection } from './shortcuts-section'
import { AutoDeleteSelect } from './auto-delete-select'
import { ApiLogAutoDeleteSelect } from './api-log-auto-delete-select'
import { applyWebFavicon, getWebFaviconHref } from '@renderer/lib/favicon'
import { agentsRunInAppSandbox, appUpdatesItself, keepsMacAwake } from '@renderer/lib/capabilities'
import { SandboxNotice } from './sandbox-notice'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'
import {
  TriangleAlert,
  Download,
  CheckCircle2,
  Loader2,
  Monitor,
  Sun,
  Moon,
  Upload,
  Trash2,
} from 'lucide-react'

const THEME_OPTIONS: readonly SegmentedOption<'system' | 'light' | 'dark'>[] = [
  { value: 'system', label: 'System', icon: Monitor, ariaLabel: 'System theme' },
  { value: 'light', label: 'Light', icon: Sun, ariaLabel: 'Light theme' },
  { value: 'dark', label: 'Dark', icon: Moon, ariaLabel: 'Dark theme' },
]

interface KeepAwakeRowProps {
  enabled: boolean
  onToggle: (checked: boolean) => void
  disabled: boolean
}

/**
 * Keep Awake row reveals its overheating warning inline only while the feature
 * is enabled — so users see the caveat exactly when it's relevant.
 */
function KeepAwakeRow({ enabled, onToggle, disabled }: KeepAwakeRowProps) {
  return (
    <SettingRow
      name="Keep Awake"
      help="Stops your Mac from sleeping while its lid is closed. Turning it on asks for administrator access."
      htmlFor="keep-awake"
      right={
        <Switch
          id="keep-awake"
          checked={enabled}
          onCheckedChange={onToggle}
          disabled={disabled}
        />
      }
    >
      {enabled && (
        <div className="flex gap-2 mt-2 rounded-item bg-yellow-500/10 px-2.5 py-2 text-[11px] text-yellow-700 dark:text-yellow-500/90 leading-relaxed">
          <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <p>
            Drains battery charge faster. Avoid using in a bag or enclosed space — restricted airflow can cause overheating.
          </p>
        </div>
      )}
    </SettingRow>
  )
}

const CARD_CLASS = SETTINGS_CARD_CLASS
const SECTION_HEADING = SETTINGS_SECTION_HEADING
const FAVICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,.ico'
const FAVICON_MAX_BYTES = 256 * 1024
const FAVICON_ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/svg+xml',
])

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Failed to read image'))
    }
    reader.onerror = () => reject(new Error('Failed to read image'))
    reader.readAsDataURL(file)
  })
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string') {
    return error.error
  }
  if (error instanceof Error) return error.message
  return 'Failed to update web icon'
}

interface GeneralTabProps {
  onOpenWizard: () => void
}

export function GeneralTab({ onOpenWizard }: GeneralTabProps) {
  const { data: userSettings, isLoading: isUserSettingsLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { data: globalSettings } = useSettings()
  const updateGlobalSettings = useUpdateSettings()
  const { isAuthMode, isAdmin } = useUser()
  const showAdminFeatures = !isAuthMode || isAdmin
  const [keepAwakeLoading, setKeepAwakeLoading] = useState(false)
  const [faviconSaving, setFaviconSaving] = useState(false)
  const [faviconError, setFaviconError] = useState<string | null>(null)
  const faviconInputRef = useRef<HTMLInputElement>(null)

  const isElectronApp = !!window.electronAPI
  const isMacElectron = window.electronAPI?.platform === 'darwin'
  const showWebFaviconSettings = !isElectronApp && showAdminFeatures
  const customFavicon = globalSettings?.app?.hasCustomFavicon === true
  const faviconPreviewSrc = getWebFaviconHref(globalSettings?.app?.faviconUpdatedAt)

  const handleKeepAwakeToggle = async (checked: boolean) => {
    setKeepAwakeLoading(true)
    try {
      await window.electronAPI!.setKeepAwake(checked)
      updateUserSettings.mutate({ keepAwakeEnabled: checked })
    } catch {
      // User cancelled the sudo dialog or pmset failed — don't persist
    } finally {
      setKeepAwakeLoading(false)
    }
  }

  const handleFaviconFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return

    const isIcoWithMissingType = !file.type && file.name.toLowerCase().endsWith('.ico')
    if (!FAVICON_ALLOWED_TYPES.has(file.type) && !isIcoWithMissingType) {
      setFaviconError('Choose a PNG, JPEG, WebP, ICO, or SVG image.')
      return
    }

    if (file.size > FAVICON_MAX_BYTES) {
      setFaviconError('Choose an image smaller than 256KB.')
      return
    }

    setFaviconSaving(true)
    setFaviconError(null)
    try {
      let dataUrl = await readFileAsDataUrl(file)
      if (isIcoWithMissingType) {
        dataUrl = dataUrl.replace(/^data:[^;]*;base64,/, 'data:image/x-icon;base64,')
      }
      const updated = await updateGlobalSettings.mutateAsync({ app: { faviconDataUrl: dataUrl } })
      applyWebFavicon(updated.app.faviconUpdatedAt)
    } catch (error) {
      setFaviconError(errorMessage(error))
    } finally {
      setFaviconSaving(false)
    }
  }

  const handleResetFavicon = async () => {
    setFaviconSaving(true)
    setFaviconError(null)
    try {
      const updated = await updateGlobalSettings.mutateAsync({ app: { faviconDataUrl: null } })
      applyWebFavicon(updated.app.faviconUpdatedAt)
    } catch (error) {
      setFaviconError(errorMessage(error))
    } finally {
      setFaviconSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {agentsRunInAppSandbox() && <SandboxNotice />}

      {appUpdatesItself() && (
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Updates</h3>
          <UpdatesCard />
        </div>
      )}

      <div className="space-y-2">
        <h3 className={SECTION_HEADING}>General</h3>
        <div className={CARD_CLASS}>
          <SettingRow
            name="Appearance"
            right={
              <SegmentedControl
                aria-label="Appearance"
                value={userSettings?.theme ?? 'system'}
                options={THEME_OPTIONS}
                onChange={(theme) => updateUserSettings.mutate({ theme })}
                disabled={isUserSettingsLoading}
              />
            }
          />
          <SettingRow
            name="Time zone for scheduled tasks"
            right={
              <TimezonePicker
                variant="row"
                value={userSettings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
                onValueChange={(value) => {
                  updateUserSettings.mutate({ timezone: value })
                }}
                disabled={isUserSettingsLoading}
              />
            }
          />
          {isElectronApp && (
            <SettingRow
              name={`Show agent status in ${isMacElectron ? 'menu bar' : 'system tray'}`}
              htmlFor="show-menu-bar-icon"
              right={
                <Switch
                  id="show-menu-bar-icon"
                  checked={userSettings?.showMenuBarIcon !== false}
                  onCheckedChange={(checked: boolean) => {
                    window.electronAPI?.setTrayVisible(checked)
                    updateUserSettings.mutate({ showMenuBarIcon: checked })
                  }}
                  disabled={isUserSettingsLoading}
                />
              }
            />
          )}
          {keepsMacAwake() && (
            <KeepAwakeRow
              enabled={userSettings?.keepAwakeEnabled === true}
              onToggle={handleKeepAwakeToggle}
              disabled={isUserSettingsLoading || keepAwakeLoading}
            />
          )}
        </div>
      </div>

      {isElectronApp && <ShortcutsSection />}

      {showWebFaviconSettings && (
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Branding</h3>
          <div className={CARD_CLASS}>
            <SettingRow
              name="Browser tab icon"
              right={
                <>
                  <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-control border bg-muted">
                    <img src={faviconPreviewSrc} alt="" className="h-6 w-6 object-contain" />
                  </div>
                  <input
                    ref={faviconInputRef}
                    type="file"
                    accept={FAVICON_ACCEPT}
                    className="hidden"
                    onChange={handleFaviconFileChange}
                  />
                  <Button
                    type="button"
                    variant="soft"
                    size="sm"
                    onClick={() => faviconInputRef.current?.click()}
                    disabled={!globalSettings || faviconSaving}
                  >
                    {faviconSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
                    Upload
                  </Button>
                  {customFavicon && (
                    <TooltipProvider delayDuration={0}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={handleResetFavicon}
                            disabled={!globalSettings || faviconSaving}
                            aria-label="Reset web icon"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Reset web icon</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </>
              }
            >
              {faviconError && (
                <p className="mt-2 text-[11px] text-destructive">{faviconError}</p>
              )}
            </SettingRow>
          </div>
        </div>
      )}

      {/* Telemetry toggles are desktop-only; retention controls are
          server-wide, so in auth mode they are admin-only. */}
      {showAdminFeatures && (
        <div className="space-y-2">
          <h3 className={SECTION_HEADING}>Privacy</h3>
          <div className={CARD_CLASS}>
            {!isAuthMode && (
              <>
                <SettingRow
                  name="Share error reports"
                  htmlFor="share-error-reports"
                  right={
                    <Switch
                      id="share-error-reports"
                      checked={globalSettings?.shareErrorReports !== false}
                      onCheckedChange={(checked: boolean) => {
                        updateGlobalSettings.mutate({ shareErrorReports: checked })
                      }}
                      disabled={!globalSettings}
                    />
                  }
                />
                <SettingRow
                  name="Share anonymous usage data"
                  htmlFor="share-analytics"
                  right={
                    <Switch
                      id="share-analytics"
                      checked={!!globalSettings?.shareAnalytics}
                      onCheckedChange={(checked: boolean) => {
                        updateGlobalSettings.mutate({ shareAnalytics: checked })
                      }}
                      disabled={!globalSettings}
                    />
                  }
                />
              </>
            )}
            <SettingRow
              name="Auto-delete inactive sessions"
              help="Starred sessions are never deleted."
              right={
                <AutoDeleteSelect
                  value={globalSettings?.app?.autoDeleteInactiveDays}
                  onChange={(days) => {
                    updateGlobalSettings.mutate({ app: { autoDeleteInactiveDays: days } })
                  }}
                />
              }
            />
            <SettingRow
              name="Auto-delete API and MCP logs"
              right={
                <ApiLogAutoDeleteSelect
                  value={globalSettings?.app?.apiLogAutoDeleteDays}
                  onChange={(days) => {
                    updateGlobalSettings.mutate({ app: { apiLogAutoDeleteDays: days } })
                  }}
                />
              }
            />
          </div>
        </div>
      )}

      {showAdminFeatures && (
        <div className={CARD_CLASS}>
          <SettingRow
            name="Setup wizard"
            right={
              <Button variant="soft" size="sm" onClick={onOpenWizard} data-testid="rerun-wizard-button">
                Re-run wizard
              </Button>
            }
          />
        </div>
      )}
    </div>
  )
}

function UpdatesCard() {
  const { data: userSettings } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()
  const { track } = useAnalyticsTracking()
  const status = useUpdateStatus()

  const handleCheck = useCallback(async () => {
    track('updates_checked')
    await window.electronAPI?.checkForUpdates()
  }, [track])

  const handleDownload = useCallback(async () => {
    await window.electronAPI?.downloadUpdate()
  }, [])

  const handleInstall = useCallback(() => {
    window.electronAPI?.installUpdate()
  }, [])

  // Idle has nothing to report: the button already says what the row does.
  let statusText: ReactNode = null
  if (status.state === 'checking') statusText = 'Checking for updates…'
  else if (status.state === 'not-available') statusText = 'You are on the latest version'
  else if (status.state === 'available') statusText = `Version ${status.version} is available`
  else if (status.state === 'downloading')
    statusText = (
      <>
        Downloading… <span className="tabular-nums">{Math.round(status.progress ?? 0)}%</span>
      </>
    )
  else if (status.state === 'downloaded') statusText = `Version ${status.version} is ready to install`
  else if (status.state === 'error') statusText = `Update error: ${status.error}`

  return (
    <div className={CARD_CLASS}>
      <SettingRow
        name="Software updates"
        status={statusText}
        right={
          <>
            {(status.state === 'idle' ||
              status.state === 'not-available' ||
              status.state === 'error') && (
              <Button variant="soft" size="sm" onClick={handleCheck}>
                Check for updates
              </Button>
            )}
            {status.state === 'checking' && (
              <Button variant="soft" size="sm" disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Checking…
              </Button>
            )}
            {status.state === 'available' && (
              <Button variant="soft" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            )}
            {status.state === 'downloading' && (
              <Button variant="soft" size="sm" disabled>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                <span className="tabular-nums">{Math.round(status.progress ?? 0)}%</span>
              </Button>
            )}
            {status.state === 'downloaded' && (
              <Button size="sm" onClick={handleInstall}>
                <CheckCircle2 className="h-4 w-4 mr-2" />
                Restart & update
              </Button>
            )}
          </>
        }
      />
      <SettingRow
        name="Automatically check for updates"
        htmlFor="auto-check-updates"
        right={
          <Switch
            id="auto-check-updates"
            checked={userSettings?.autoCheckUpdates !== false}
            onCheckedChange={(checked: boolean) => {
              updateUserSettings.mutate({ autoCheckUpdates: checked })
            }}
          />
        }
      />
      <SettingRow
        name="Include pre-release versions"
        htmlFor="prerelease-updates"
        right={
          <Switch
            id="prerelease-updates"
            checked={!!userSettings?.allowPrereleaseUpdates}
            onCheckedChange={(checked: boolean) => {
              updateUserSettings.mutate({ allowPrereleaseUpdates: checked })
            }}
          />
        }
      />
    </div>
  )
}
