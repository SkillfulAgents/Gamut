import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { useSettings, useUpdateSettings } from '@renderer/hooks/use-settings'
import { Plus, X, Globe } from 'lucide-react'
import type { AuthSettings } from '@shared/lib/config/settings'
import { SETTINGS_CARD_CLASS, SETTINGS_SECTION_HEADING, SettingRow } from './setting-row'

const NUMBER_FIELD = 'h-8 w-24 text-xs'
/** One entry of a list a card holds (a signup domain, a trusted origin), with its remove button. */
const LIST_ROW = 'flex items-center gap-2 py-2 pl-4 pr-2'

interface AuthTabProps {
  /** Platform-controlled deployments manage signup/auth methods on Platform. */
  hideLocalAuthSections?: boolean
}

export function AuthTab({ hideLocalAuthSections = false }: AuthTabProps) {
  const { data: settings, isLoading } = useSettings()
  const updateSettings = useUpdateSettings()
  const [newOrigin, setNewOrigin] = useState('')
  const [newDomain, setNewDomain] = useState('')
  const [originError, setOriginError] = useState<string | null>(null)

  const auth: AuthSettings = settings?.auth ?? {}

  const updateAuth = (partial: Partial<AuthSettings>) => {
    updateSettings.mutate({ auth: partial })
  }

  const origins = auth.trustedOrigins ?? []

  const addOrigin = () => {
    const trimmed = newOrigin.trim()
    if (!trimmed) return
    try {
      const url = new URL(trimmed)
      const origin = url.origin
      if (origins.includes(origin)) {
        setOriginError('This origin is already in the list.')
        return
      }
      updateAuth({ trustedOrigins: [...origins, origin] })
      setNewOrigin('')
      setOriginError(null)
    } catch {
      setOriginError('Please enter a valid URL (e.g., https://example.com)')
    }
  }

  const removeOrigin = (origin: string) => {
    updateAuth({ trustedOrigins: origins.filter((o) => o !== origin) })
  }

  const domains = auth.allowedSignupDomains ?? []

  const addDomain = () => {
    const trimmed = newDomain.trim().toLowerCase()
    if (!trimmed) return
    if (domains.includes(trimmed)) {
      setNewDomain('')
      return
    }
    updateAuth({ allowedSignupDomains: [...domains, trimmed] })
    setNewDomain('')
  }

  const removeDomain = (domain: string) => {
    updateAuth({ allowedSignupDomains: domains.filter((d) => d !== domain) })
  }

  const localAuthOff = !(auth.allowLocalAuth ?? true)

  return (
    <div className="space-y-6">
      {!hideLocalAuthSections && (
        <>
          <div className="space-y-2">
            <h3 className={SETTINGS_SECTION_HEADING}>Signup & access</h3>
            <div className={SETTINGS_CARD_CLASS}>
              <SettingRow
                name="Who can sign up"
                htmlFor="signup-mode"
                right={
                  <Select
                    variant="row"
                    value={auth.signupMode ?? 'invitation_only'}
                    onValueChange={(value) => updateAuth({ signupMode: value as AuthSettings['signupMode'] })}
                    disabled={isLoading}
                  >
                    <SelectTrigger id="signup-mode" data-testid="auth-signup-mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open">Open</SelectItem>
                      <SelectItem value="domain_restricted">Domain Restricted</SelectItem>
                      <SelectItem value="invitation_only">Invitation Only</SelectItem>
                      <SelectItem value="closed">Closed</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />

              {auth.signupMode === 'domain_restricted' && (
                <>
                  {domains.map((domain) => (
                    <div key={domain} className={LIST_ROW}>
                      <span className="flex-1 font-mono text-xs truncate">{domain}</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0"
                        onClick={() => removeDomain(domain)}
                        disabled={isLoading}
                        aria-label={`Remove ${domain}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                  <SettingRow
                    name="Allowed signup domains"
                    // With no domain listed nobody can sign up, which the mode alone doesn't say.
                    status={domains.length === 0 ? 'No domains yet, so every signup is rejected.' : undefined}
                    stack
                    right={
                      <>
                        <Input
                          value={newDomain}
                          onChange={(e) => setNewDomain(e.target.value)}
                          placeholder="example.com"
                          className="h-8 w-full md:w-[220px] text-xs font-mono"
                          disabled={isLoading}
                          aria-label="Domain to allow"
                          data-testid="auth-add-domain-input"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') addDomain()
                          }}
                        />
                        <Button
                          onClick={addDomain}
                          disabled={!newDomain.trim() || isLoading}
                          variant="soft"
                          size="sm"
                          data-testid="auth-add-domain-button"
                        >
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </Button>
                      </>
                    }
                  />
                </>
              )}

              <SettingRow
                name="Require admin approval for new signups"
                htmlFor="require-approval"
                right={
                  <Switch
                    id="require-approval"
                    data-testid="auth-require-approval"
                    checked={auth.requireAdminApproval ?? true}
                    onCheckedChange={(checked) => updateAuth({ requireAdminApproval: checked })}
                    disabled={isLoading}
                  />
                }
              />

              <SettingRow
                name="Role for new users"
                htmlFor="default-role"
                right={
                  <Select
                    variant="row"
                    value={auth.defaultUserRole ?? 'member'}
                    onValueChange={(value) => updateAuth({ defaultUserRole: value as 'member' | 'admin' })}
                    disabled={isLoading}
                  >
                    <SelectTrigger id="default-role" data-testid="auth-default-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <h3 className={SETTINGS_SECTION_HEADING}>Authentication methods</h3>
            <div className={SETTINGS_CARD_CLASS}>
              <SettingRow
                name="Email and password sign-in"
                htmlFor="allow-local-auth"
                right={
                  <Switch
                    id="allow-local-auth"
                    data-testid="auth-allow-local"
                    checked={auth.allowLocalAuth ?? true}
                    onCheckedChange={(checked) => updateAuth({ allowLocalAuth: checked })}
                    disabled={isLoading}
                  />
                }
              />
              <SettingRow
                name="Social sign-in"
                help="The sign-in providers themselves are configured separately."
                htmlFor="allow-social-auth"
                right={
                  <Switch
                    id="allow-social-auth"
                    data-testid="auth-allow-social"
                    checked={auth.allowSocialAuth ?? false}
                    onCheckedChange={(checked) => updateAuth({ allowSocialAuth: checked })}
                    disabled={isLoading}
                  />
                }
              />
            </div>
          </div>

          <div className="space-y-2">
            <h3 className={SETTINGS_SECTION_HEADING}>Password policy</h3>
            <div className={SETTINGS_CARD_CLASS}>
              <SettingRow
                name="Minimum password length"
                htmlFor="password-min-length"
                right={
                  <Input
                    id="password-min-length"
                    type="number"
                    min={8}
                    max={128}
                    value={auth.passwordMinLength ?? 12}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10)
                      if (!isNaN(val) && val >= 8 && val <= 128) {
                        updateAuth({ passwordMinLength: val })
                      }
                    }}
                    className={NUMBER_FIELD}
                    disabled={isLoading || localAuthOff}
                    data-testid="auth-password-min-length"
                  />
                }
              />
              <SettingRow
                name="Require uppercase, lowercase, numbers, and symbols"
                htmlFor="require-complexity"
                right={
                  <Switch
                    id="require-complexity"
                    data-testid="auth-require-complexity"
                    checked={auth.passwordRequireComplexity ?? true}
                    onCheckedChange={(checked) => updateAuth({ passwordRequireComplexity: checked })}
                    disabled={isLoading || localAuthOff}
                  />
                }
              />
            </div>
          </div>
        </>
      )}

      <div className="space-y-2">
        <h3 className={SETTINGS_SECTION_HEADING}>Session & lockout</h3>
        <div className={SETTINGS_CARD_CLASS}>
          <SettingRow
            name="Sign out after idle minutes"
            htmlFor="session-idle-timeout"
            right={
              <Input
                id="session-idle-timeout"
                type="number"
                min={5}
                value={auth.sessionIdleTimeoutMin ?? 60}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 5) updateAuth({ sessionIdleTimeoutMin: val })
                }}
                className={NUMBER_FIELD}
                disabled={isLoading}
                data-testid="auth-session-idle-timeout"
              />
            }
          />
          <SettingRow
            name="Longest session in hours"
            htmlFor="session-max-lifetime"
            right={
              <Input
                id="session-max-lifetime"
                type="number"
                min={1}
                value={auth.sessionMaxLifetimeHrs ?? 24}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 1) updateAuth({ sessionMaxLifetimeHrs: val })
                }}
                className={NUMBER_FIELD}
                disabled={isLoading}
                data-testid="auth-session-max-lifetime"
              />
            }
          />
          <SettingRow
            name="Max concurrent sessions"
            htmlFor="max-sessions"
            right={
              <Input
                id="max-sessions"
                type="number"
                min={1}
                value={auth.maxConcurrentSessions ?? 5}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 1) updateAuth({ maxConcurrentSessions: val })
                }}
                className={NUMBER_FIELD}
                disabled={isLoading}
                data-testid="auth-max-sessions"
              />
            }
          />
          <SettingRow
            name="Failed sign-ins before lockout"
            htmlFor="lockout-threshold"
            right={
              <Input
                id="lockout-threshold"
                type="number"
                min={1}
                value={auth.accountLockoutThreshold ?? 10}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 1) updateAuth({ accountLockoutThreshold: val })
                }}
                className={NUMBER_FIELD}
                disabled={isLoading}
                data-testid="auth-lockout-threshold"
              />
            }
          />
          <SettingRow
            name="Lockout length in minutes"
            help="0 keeps the account locked until an admin unlocks it."
            htmlFor="lockout-duration"
            right={
              <Input
                id="lockout-duration"
                type="number"
                min={0}
                value={auth.accountLockoutDurationMin ?? 30}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10)
                  if (!isNaN(val) && val >= 0) updateAuth({ accountLockoutDurationMin: val })
                }}
                className={NUMBER_FIELD}
                disabled={isLoading}
                data-testid="auth-lockout-duration"
              />
            }
          />
        </div>
      </div>

      <div className="space-y-2">
        <h3 className={SETTINGS_SECTION_HEADING}>Trusted origins</h3>
        <div className={SETTINGS_CARD_CLASS}>
          {origins.map((origin) => (
            <div key={origin} className={LIST_ROW}>
              <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 font-mono text-xs truncate">{origin}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                onClick={() => removeOrigin(origin)}
                disabled={isLoading}
                aria-label={`Remove ${origin}`}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <SettingRow
            name="Add a trusted origin"
            help="Origins allowed for CORS and CSRF protection."
            // An empty list is not a locked-down one, so say what it means.
            status={origins.length === 0 ? 'None yet, so every origin is allowed.' : undefined}
            stack
            right={
              <>
                <Input
                  value={newOrigin}
                  onChange={(e) => {
                    setNewOrigin(e.target.value)
                    setOriginError(null)
                  }}
                  placeholder="https://example.com"
                  className="h-8 w-full md:w-[220px] text-xs font-mono"
                  disabled={isLoading}
                  aria-label="Origin to trust"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addOrigin()
                  }}
                />
                <Button
                  onClick={addOrigin}
                  disabled={!newOrigin.trim() || isLoading}
                  variant="soft"
                  size="sm"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </>
            }
          >
            {originError && <p className="mt-2 text-[11px] text-destructive">{originError}</p>}
          </SettingRow>
        </div>
      </div>
    </div>
  )
}
