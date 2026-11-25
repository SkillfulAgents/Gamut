import { useState, useEffect } from 'react'
import { Switch } from '@renderer/components/ui/switch'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import { BellRing, Info, TriangleAlert } from 'lucide-react'
import { isElectron } from '@renderer/lib/env'
import {
  requestNotificationPermission,
  hasNotificationPermission,
  showOSNotification,
} from '@renderer/lib/os-notifications'
import {
  supportsDeclarativeWebPush,
  isThisDeviceSubscribed,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from '@renderer/lib/push-notifications'
import { isIos } from '@renderer/hooks/use-pwa-install'
import { openExternalUrl } from '@renderer/lib/open-external'
import { clientFacts } from '@renderer/lib/facts'
import { macBundleId } from '@shared/lib/facts/bundle-id'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'
import { cn } from '@shared/lib/utils/cn'
import { SettingsHeaderActions } from './settings-page'
import { SegmentedControl, type SegmentedOption } from '@renderer/components/ui/segmented-control'

const ON_OFF_OPTIONS: readonly SegmentedOption<'on' | 'off'>[] = [
  { value: 'on', label: 'On', ariaLabel: 'Notifications on' },
  { value: 'off', label: 'Off', ariaLabel: 'Notifications off' },
]

/** This app's page in System Settings → Notifications, by the bundle id it runs under. */
function macosNotificationSettingsUrl(): string {
  return `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${macBundleId(clientFacts())}`
}

const CARD_CLASS = SETTINGS_CARD_CLASS

type DevicePushState = 'loading' | 'unsubscribed' | 'subscribed' | 'denied' | 'error'

/**
 * "Push to this device" card — Web Push opt-in for the current browser/PWA.
 * Rendered only where declarative Web Push exists (WebKit; on iOS that means
 * the app is installed to the Home Screen and served over HTTPS), so the
 * card's presence is itself the capability check.
 */
function DevicePushSection() {
  const [state, setState] = useState<DevicePushState>('loading')

  useEffect(() => {
    let cancelled = false
    isThisDeviceSubscribed()
      .then((subscribed) => {
        if (!cancelled) {
          setState(subscribed ? 'subscribed' : 'unsubscribed')
        }
      })
      // getSubscription() can reject when the push service is unreachable —
      // without this the card is stranded in 'loading' with a dead button.
      .catch(() => {
        if (!cancelled) {
          setState('error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggle = async () => {
    try {
      if (state === 'subscribed') {
        setState('loading')
        await unsubscribeThisDevice()
        setState('unsubscribed')
      } else {
        // No setState before subscribeThisDevice: the permission prompt must
        // stay inside the user-gesture call stack (iOS requirement).
        const result = await subscribeThisDevice()
        setState(
          result === 'subscribed' ? 'subscribed' : result === 'permission-denied' ? 'denied' : 'error'
        )
      }
    } catch {
      setState('error')
    }
  }

  // Only what went wrong is worth a line: on and off are the button's to say.
  const status =
    state === 'denied'
      ? 'Notification permission was denied. Re-enable it for this app in system notification settings.'
      : state === 'error'
        ? "Couldn't enable push notifications on this device. Try again."
        : undefined

  return (
    <div className={CARD_CLASS}>
      <SettingRow
        name="Push notifications on this device"
        help="Notifies this device when a session finishes or needs input, even while the app is closed."
        status={status}
        right={
          <Button
            size="sm"
            variant="soft"
            onClick={handleToggle}
            disabled={state === 'loading' || state === 'denied'}
          >
            {state === 'subscribed' ? 'Disable' : 'Enable'}
          </Button>
        }
      />
    </div>
  )
}

export function NotificationsTab() {
  const { data: userSettings, isLoading } = useUserSettings()
  const updateUserSettings = useUpdateUserSettings()

  // Local state for optimistic UI updates
  const [localSettings, setLocalSettings] = useState<{
    enabled: boolean
    sessionComplete: boolean
    sessionWaiting: boolean
    sessionScheduled: boolean
    platformNotification: boolean
    notifyWhenUnfocused: boolean
  } | null>(null)

  // Browser notification permission state
  const [browserPermission, setBrowserPermission] = useState<'granted' | 'denied' | 'default'>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  )

  const [osNotificationsBlocked, setOsNotificationsBlocked] = useState(false)
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.getOsNotificationsBlocked) return
    const check = () => void api.getOsNotificationsBlocked().then(setOsNotificationsBlocked)
    check()
    // The user changes the toggle in System Settings, then comes back to the app.
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  // Reset local state when settings update
  useEffect(() => {
    if (userSettings) {
      setLocalSettings(null)
    }
  }, [userSettings])

  const notificationSettings = localSettings ?? userSettings?.notifications ?? {
    enabled: true,
    sessionComplete: true,
    sessionWaiting: true,
    sessionScheduled: true,
    platformNotification: true,
    notifyWhenUnfocused: false,
  }

  const updateNotificationSetting = (key: string, value: boolean) => {
    const newSettings = { ...notificationSettings, [key]: value }
    setLocalSettings(newSettings)
    updateUserSettings.mutate({ notifications: newSettings })
  }

  const handleRequestPermission = async () => {
    const granted = await requestNotificationPermission()
    setBrowserPermission(granted ? 'granted' : 'denied')
  }

  const showBrowserPermissionSection = !isElectron() && !hasNotificationPermission()

  return (
    <div className="space-y-6">
      {osNotificationsBlocked && (
        <Alert variant="destructive">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>Notifications for Gamut are turned off in System Settings.</span>
            <Button
              size="sm"
              variant="soft"
              onClick={() => void openExternalUrl(macosNotificationSettingsUrl())}
            >
              Open System Settings
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Browser Permission Section (web only) */}
      {showBrowserPermissionSection && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="flex items-center justify-between">
            <span>Browser notification permission required for OS notifications.</span>
            {browserPermission === 'denied' ? (
              <span className="text-xs text-muted-foreground">
                Permission denied. Enable in browser settings.
              </span>
            ) : (
              <Button size="sm" variant="soft" onClick={handleRequestPermission}>
                Request permission
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      {/* The master switch sits on the page title's row: it turns the page's subject on, and everything below is
          what that covers. */}
      <SettingsHeaderActions>
        {/* On/Off as a segmented control: a bare switch has no label up here, and these two words are one. */}
        <SegmentedControl
          aria-label="Notifications"
          value={notificationSettings.enabled ? 'on' : 'off'}
          options={ON_OFF_OPTIONS}
          onChange={(next) => updateNotificationSetting('enabled', next === 'on')}
          disabled={isLoading}
        />
      </SettingsHeaderActions>

      {/* What the master switch governs: dimmed, not hidden, while it is off, so it still shows what it would turn on. */}
      <div
        className={cn('space-y-6 transition-opacity', !notificationSettings.enabled && 'opacity-50')}
        data-testid="notification-choices"
        data-disabled={!notificationSettings.enabled || undefined}
      >
        <div className="space-y-2">
          <h3 className={SETTINGS_SECTION_HEADING}>Notify me when</h3>
          <div className={CARD_CLASS}>
            <SettingRow
              htmlFor="notify-session-complete"
              name="Agent finishes a session"
              right={
                <Switch
                  id="notify-session-complete"
                  checked={notificationSettings.sessionComplete}
                  onCheckedChange={(checked) => updateNotificationSetting('sessionComplete', checked)}
                  disabled={isLoading || !notificationSettings.enabled}
                />
              }
            />
            <SettingRow
              htmlFor="notify-session-waiting"
              name="Agent needs your input"
              right={
                <Switch
                  id="notify-session-waiting"
                  checked={notificationSettings.sessionWaiting}
                  onCheckedChange={(checked) => updateNotificationSetting('sessionWaiting', checked)}
                  disabled={isLoading || !notificationSettings.enabled}
                />
              }
            />
            <SettingRow
              htmlFor="notify-session-scheduled"
              name="Scheduled task starts"
              right={
                <Switch
                  id="notify-session-scheduled"
                  checked={notificationSettings.sessionScheduled}
                  onCheckedChange={(checked) => updateNotificationSetting('sessionScheduled', checked)}
                  disabled={isLoading || !notificationSettings.enabled}
                />
              }
            />
            <SettingRow
              htmlFor="notify-platform-notification"
              name="Product announcements and account updates"
              right={
                <Switch
                  id="notify-platform-notification"
                  checked={notificationSettings.platformNotification}
                  onCheckedChange={(checked) => updateNotificationSetting('platformNotification', checked)}
                  disabled={isLoading || !notificationSettings.enabled}
                />
              }
            />
          </div>
        </div>

        <div className={CARD_CLASS}>
          <SettingRow
            htmlFor="notify-when-unfocused"
            name="Also notify for the open session when Gamut is in the background"
            help="The session you have open normally stays quiet. With this on, it notifies you too whenever the Gamut window is behind another app: useful for a long run you have left in the background."
            right={
              <Switch
                id="notify-when-unfocused"
                checked={notificationSettings.notifyWhenUnfocused}
                onCheckedChange={(checked) => updateNotificationSetting('notifyWhenUnfocused', checked)}
                disabled={isLoading || !notificationSettings.enabled}
              />
            }
          />
        </div>
      </div>

      {supportsDeclarativeWebPush() && <DevicePushSection />}
      {!isElectron() && !supportsDeclarativeWebPush() && isIos() && (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>
            To get push notifications on this device, add the app to your Home Screen (Share →
            Add to Home Screen) and open it from there. Requires iOS 18.4+ and an HTTPS address.
          </AlertDescription>
        </Alert>
      )}

      {/* A check, not a setting: a quiet link under the cards, like Admin's debug tools, not a card of its own. */}
      <button
        type="button"
        onClick={() => showOSNotification('Test Notification', 'Notifications are working!')}
        title={isElectron() ? 'Also asks for macOS notification permission if it has not been granted.' : undefined}
        className="flex items-center gap-1.5 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="send-test-notification"
      >
        <BellRing className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Send a test notification</span>
      </button>
    </div>
  )
}
