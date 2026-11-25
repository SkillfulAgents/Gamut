import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'react-qr-code'
import { ExternalLink, Loader2, QrCode, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { apiFetch } from '@renderer/lib/api'
import { getRemoteDeploymentUrl, targetIsRemote } from '@renderer/lib/api-target'
import { openExternalUrl } from '@renderer/lib/open-external'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { cn } from '@shared/lib/utils'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'

interface PairingToken {
  token: string
  expiresAt: string
  deploymentUrl: string
}

interface MobileDevice {
  id: string
  deviceName: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
  isCurrent: boolean
}

/** Mint interval headroom: re-mint while the QR is visible ~60s before expiry. */
const REMINT_BEFORE_EXPIRY_MS = 60 * 1000

const APP_STORE_URL = 'https://apps.apple.com/app/id6801340586'

function buildDeepLink(pairing: PairingToken): string {
  return `gamut://connect?v=1&url=${encodeURIComponent(pairing.deploymentUrl)}&token=${pairing.token}`
}

async function mintPairingToken(): Promise<PairingToken> {
  const res = await apiFetch('/api/auth/mobile/pairing-token', { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || 'Failed to create pairing code')
  }
  return res.json()
}

function AppStoreButton() {
  const { track } = useAnalyticsTracking()
  return (
    <Button
      variant="soft"
      size="sm"
      onClick={() => {
        track('app_store_link_clicked', { surface: 'settings_mobile' })
        void openExternalUrl(APP_STORE_URL)
      }}
      data-testid="mobile-app-store-link"
    >
      <ExternalLink className="h-4 w-4 mr-2" />
      Get the iOS app
    </Button>
  )
}

// --- QR pairing card ---

function PairingQrCard() {
  const [pairing, setPairing] = useState<PairingToken | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [minting, setMinting] = useState(false)
  const mintInFlight = useRef(false)

  const mint = useCallback(async () => {
    // The expiry interval ticks every second. Without a synchronous guard, a
    // slow request starts several overlapping mints; the three-token server cap
    // can then evict a late response before it is rendered as the current QR.
    if (mintInFlight.current) return
    mintInFlight.current = true
    setMinting(true)
    setError(null)
    try {
      setPairing(await mintPairingToken())
    } catch (err) {
      setPairing(null)
      setError(err instanceof Error ? err.message : 'Failed to create pairing code')
    } finally {
      mintInFlight.current = false
      setMinting(false)
    }
  }, [])

  // Countdown + auto-re-mint while a code is on screen. Tokens are minted on
  // demand only — never on tab open.
  useEffect(() => {
    if (!pairing) return
    const tick = () => {
      const remainingMs = new Date(pairing.expiresAt).getTime() - Date.now()
      setSecondsLeft(Math.max(0, Math.ceil(remainingMs / 1000)))
      if (remainingMs <= REMINT_BEFORE_EXPIRY_MS) {
        void mint()
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [pairing, mint])

  const deepLink = pairing ? buildDeepLink(pairing) : null

  return (
    <SettingRow
      name="Scan a pairing code with the Gamut mobile app"
      help="Connects the app to this workspace. Codes are single-use and expire after a few minutes."
      right={
        <>
          {!pairing && (
            <Button size="sm" onClick={() => void mint()} disabled={minting} data-testid="mobile-pairing-mint">
              {minting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <QrCode className="h-4 w-4 mr-2" />
              )}
              Show pairing code
            </Button>
          )}
          <AppStoreButton />
        </>
      }
    >
      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {pairing && (
        <div className="mt-3 space-y-3">
          <div className="inline-flex flex-col items-center gap-2 rounded-card border p-4 bg-white">
            {deepLink && <QRCode value={deepLink} size={192} />}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Code refreshes automatically — expires in {secondsLeft}s
          </p>
          {/* The raw deep link, for copying into the app manually (and E2E). */}
          <p
            className="text-[11px] font-mono break-all text-muted-foreground select-all"
            data-testid="mobile-pairing-deeplink"
          >
            {deepLink}
          </p>
        </div>
      )}
    </SettingRow>
  )
}

// --- Open-the-app button (same-device pairing) ---

function ConnectAppButton() {
  const [minting, setMinting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mint on click, then navigate to the freshly-minted deep link. The href is
  // decorative until then — a stale link would carry an expired token.
  const handleClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (minting) return
    setMinting(true)
    setError(null)
    try {
      const pairing = await mintPairingToken()
      window.location.href = buildDeepLink(pairing)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    } finally {
      setMinting(false)
    }
  }

  return (
    <SettingRow
      name="Already on this device? Open the app directly"
      right={
        /* A real anchor (deep links belong on links), styled as an outline
           button. Not `Button asChild`: this repo's Button always renders a
           conditional loading child, which breaks Radix Slot's single-child
           requirement. */
        <a
          href="gamut://connect"
          onClick={handleClick}
          data-testid="mobile-connect-app-button"
          className={cn(buttonVariants({ variant: 'soft', size: 'sm' }), minting && 'pointer-events-none opacity-50')}
        >
          {minting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Smartphone className="h-4 w-4 mr-2" />
          )}
          Connect app on this device
        </a>
      }
    >
      {error && (
        <Alert variant="destructive" className="mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </SettingRow>
  )
}

// --- Cloud workspace: pair from the browser ---

/**
 * The desktop app drives a cloud workspace on a session minted by token
 * exchange, and the deployment mints pairing tokens only for sessions a person
 * signed in to (password or OIDC) — a minted credential must not fan out into
 * more of them. So pairing happens where the user can sign in: the workspace
 * itself, in a browser.
 */
function PairInBrowserCard() {
  const deploymentUrl = getRemoteDeploymentUrl()
  return (
    <SettingRow
      name="Pair a phone from the cloud workspace in your browser"
      help="Pairing needs you to sign in to the cloud workspace directly. Open it in your browser and pair from Settings → Mobile there."
      right={
        <>
          {deploymentUrl && (
            <Button
              size="sm"
              onClick={() => void openExternalUrl(`${deploymentUrl}/settings/mobile`)}
              data-testid="mobile-pairing-open-browser"
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Open in browser
            </Button>
          )}
          <AppStoreButton />
        </>
      }
    />
  )
}

// --- Paired devices list ---

function formatDate(iso: string): string {
  const date = new Date(iso)
  return isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

function PairedDevicesList() {
  const queryClient = useQueryClient()
  const [revokeError, setRevokeError] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['mobile-devices'],
    queryFn: async (): Promise<{ devices: MobileDevice[] }> => {
      const res = await apiFetch('/api/auth/mobile/devices')
      if (!res.ok) throw new Error('Failed to load paired devices')
      return res.json()
    },
  })

  const revokeMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const res = await apiFetch(`/api/auth/mobile/devices/${deviceId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || 'Failed to revoke device')
      }
    },
    onSuccess: () => {
      setRevokeError(null)
      queryClient.invalidateQueries({ queryKey: ['mobile-devices'] })
    },
    onError: (err) => {
      setRevokeError(err instanceof Error ? err.message : 'Failed to revoke device')
    },
  })

  const devices = data?.devices ?? []

  if (isLoading) {
    return (
      <div className={cn(SETTINGS_CARD_CLASS, 'flex items-center gap-2 py-3 px-4 text-[11px] text-muted-foreground')}>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Loading devices…
      </div>
    )
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Failed to load paired devices</AlertDescription>
      </Alert>
    )
  }

  if (devices.length === 0) {
    return (
      <div className={cn(SETTINGS_CARD_CLASS, 'py-3 px-4 text-[11px] text-muted-foreground')} data-testid="mobile-devices-empty">
        No paired devices yet.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {revokeError && (
        <Alert variant="destructive">
          <AlertDescription>{revokeError}</AlertDescription>
        </Alert>
      )}
      <div className={SETTINGS_CARD_CLASS} data-testid="mobile-devices-list">
        {devices.map((device) => (
          <div key={device.id} data-testid={`mobile-device-row-${device.id}`}>
            <SettingRow
              name={`${device.deviceName || 'Mobile device'}${device.isCurrent ? ' (current)' : ''}`}
              // When it was paired and how long its access lasts: data, not a description.
              status={`Paired ${formatDate(device.createdAt)} · last renewed ${formatDate(device.updatedAt)} · expires ${formatDate(device.expiresAt)}`}
              right={
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => revokeMutation.mutate(device.id)}
                  disabled={revokeMutation.isPending}
                  data-testid={`mobile-device-revoke-${device.id}`}
                  aria-label="Revoke device"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              }
            />
          </div>
        ))}
      </div>
    </div>
  )
}

// --- Main tab ---

export function MobileTab() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className={SETTINGS_SECTION_HEADING}>Pair the mobile app</h3>
        <div className={SETTINGS_CARD_CLASS}>
          {targetIsRemote() ? (
            <PairInBrowserCard />
          ) : (
            <>
              <PairingQrCard />
              <ConnectAppButton />
            </>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className={SETTINGS_SECTION_HEADING}>Paired devices</h3>
          <RefreshDevicesButton />
        </div>
        <PairedDevicesList />
      </div>
    </div>
  )
}

function RefreshDevicesButton() {
  const queryClient = useQueryClient()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      onClick={() => queryClient.invalidateQueries({ queryKey: ['mobile-devices'] })}
      aria-label="Refresh devices"
    >
      <RefreshCw className="h-4 w-4" />
    </Button>
  )
}
