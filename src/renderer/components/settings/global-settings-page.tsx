import { Suspense, type ReactNode } from 'react'
import { AnimatedNavIcon } from '@renderer/components/ui/animated-nav-icon'
import { SettingsPage, type SettingsPageSection, type SettingsPageSectionGroup } from '@renderer/components/settings/settings-page'
import { lazyRouteComponent, type LinkProps } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { usePlatformAuthStatus } from '@renderer/hooks/use-platform-auth'
import type { SettingsTab } from '@renderer/router/search-schemas'
import { settingsGroupsFor, useSettingsAudience } from './settings-catalog'

// Each settings pane is a separate on-demand boundary. The navigation shell is
// immediately usable, while only the active pane (and its dependency graph) is
// downloaded. TanStack's wrapper adds preload support and one-shot recovery
// from a stale chunk URL after a new deployment.
const MobileTab = lazyRouteComponent(() => import('./mobile-tab'), 'MobileTab')
const GeneralTab = lazyRouteComponent(() => import('./general-tab'), 'GeneralTab')
const RuntimeTab = lazyRouteComponent(() => import('./runtime-tab'), 'RuntimeTab')
const AccountProviderTab = lazyRouteComponent(() => import('./account-provider-tab'), 'AccountProviderTab')
const NotificationsTab = lazyRouteComponent(() => import('./notifications-tab'), 'NotificationsTab')
const BrowserTab = lazyRouteComponent(() => import('./browser-tab'), 'BrowserTab')
const SkillsetsTab = lazyRouteComponent(() => import('./skillsets-tab'), 'SkillsetsTab')
const UsageTab = lazyRouteComponent(() => import('./usage-tab'), 'UsageTab')
const ConnectionsTab = lazyRouteComponent(() => import('./connections-tab'), 'ConnectionsTab')
const NewIntegrationButton = lazyRouteComponent(
  () => import('@renderer/components/connections/connections-list'),
  'NewIntegrationButton',
)
const LlmTab = lazyRouteComponent(() => import('./llm-tab'), 'LlmTab')
const UsersTab = lazyRouteComponent(() => import('./users-tab'), 'UsersTab')
const TeamDirectoryTab = lazyRouteComponent(() => import('./team-directory-tab'), 'TeamDirectoryTab')
const AuthTab = lazyRouteComponent(() => import('./auth-tab'), 'AuthTab')
const AdminTab = lazyRouteComponent(() => import('./admin-tab'), 'AdminTab')
const VoiceTab = lazyRouteComponent(() => import('./voice-tab'), 'VoiceTab')
const WebTab = lazyRouteComponent(() => import('./web-tab'), 'WebTab')
const AnalyticsTab = lazyRouteComponent(() => import('./analytics-tab'), 'AnalyticsTab')
const PlatformTab = lazyRouteComponent(() => import('./platform-tab'), 'PlatformTab')
const ComputerUseTab = lazyRouteComponent(() => import('./computer-use-tab'), 'ComputerUseTab')
const CapabilitiesTab = lazyRouteComponent(() => import('./capabilities-tab'), 'CapabilitiesTab')
const GlobalInstructionsTab = lazyRouteComponent(() => import('./global-instructions-tab'), 'GlobalInstructionsTab')
const AuditLogTab = lazyRouteComponent(() => import('./audit-log-tab'), 'AuditLogTab')
const ExperimentsTab = lazyRouteComponent(() => import('./experiments-tab'), 'ExperimentsTab')
const VolumesTab = lazyRouteComponent(() => import('./volumes-tab'), 'VolumesTab')
const LoginsTab = lazyRouteComponent(() => import('./logins-tab'), 'LoginsTab')
const McpServerTab = lazyRouteComponent(() => import('./mcp-server-tab'), 'McpServerTab')

function deferredTab(content: ReactNode): ReactNode {
  return (
    <Suspense
      fallback={(
        <div className="space-y-3 py-2" role="status" aria-label="Loading settings section">
          <div className="h-5 w-40 animate-pulse rounded bg-muted" />
          <div className="h-20 w-full animate-pulse rounded-card bg-muted/70" />
        </div>
      )}
    >
      {content}
    </Suspense>
  )
}

interface GlobalSettingsPageProps {
  onClose: () => void
  onOpenWizard: () => void
  initialSection?: string
  onSectionChange?: (id: string) => void
  sectionLinkProps?: (id: string) => LinkProps
}

function platformInviteHref(platformBaseUrl: string, orgId: string | null | undefined): string {
  const base = platformBaseUrl.replace(/\/+$/, '')
  // orgId is JWKS-verified and may be null; still send admins somewhere useful.
  return orgId
    ? `${base}/dashboard/organizations/${orgId}?tab=team`
    : `${base}/dashboard`
}

export function GlobalSettingsPage({ onClose, onOpenWizard, initialSection, onSectionChange, sectionLinkProps }: GlobalSettingsPageProps) {
  const { isAuthMode } = useUser()
  const { data: platformAuth } = usePlatformAuthStatus()

  // Same predicate as server isPlatformControlledAuth — not JWKS orgId.
  const hideLocalAuthSections = Boolean(platformAuth?.platformControlled)
  const platformTeamInviteHref =
    hideLocalAuthSections && platformAuth?.platformBaseUrl
      ? platformInviteHref(platformAuth.platformBaseUrl, platformAuth.orgId)
      : undefined

  const audience = useSettingsAudience()

  // What each page draws. Its name, icon, group, order and who has it come from
  // the settings catalog, which the Cmd-K palette reads too.
  const content: Record<SettingsTab, Pick<SettingsPageSection, 'render' | 'headerActions'>> = {
    general: { render: () => deferredTab(<GeneralTab onOpenWizard={onOpenWizard} />) },
    notifications: { render: () => deferredTab(<NotificationsTab />) },
    platform: { render: () => deferredTab(<PlatformTab readOnly={isAuthMode} />) },
    experiments: { render: () => deferredTab(<ExperimentsTab />) },
    analytics: { render: () => deferredTab(<AnalyticsTab />) },
    'team-directory': { render: () => deferredTab(<TeamDirectoryTab />) },
    // Keep local role/ban/remove: Platform Team cannot write Better Auth columns.
    // Invite goes to Platform when platform-controlled (local email invite is off).
    users: {
      render: () => deferredTab(
        <UsersTab
          platformControlled={hideLocalAuthSections}
          platformInviteHref={platformTeamInviteHref}
        />
      ),
    },
    auth: { render: () => deferredTab(<AuthTab hideLocalAuthSections={hideLocalAuthSections} />) },
    admin: { render: () => deferredTab(<AdminTab />) },
    mobile: { render: () => deferredTab(<MobileTab />) },
    connections: {
      render: () => deferredTab(<ConnectionsTab />),
      headerActions: <Suspense fallback={null}><NewIntegrationButton /></Suspense>,
    },
    'mcp-server': { render: () => deferredTab(<McpServerTab />) },
    volumes: { render: () => deferredTab(<VolumesTab />) },
    logins: { render: () => deferredTab(<LoginsTab />) },
    skillsets: { render: () => deferredTab(<SkillsetsTab />) },
    web: { render: () => deferredTab(<WebTab />) },
    browser: { render: () => deferredTab(<BrowserTab />) },
    'computer-use': { render: () => deferredTab(<ComputerUseTab />) },
    capabilities: { render: () => deferredTab(<CapabilitiesTab />) },
    'global-guidance': { render: () => deferredTab(<GlobalInstructionsTab />) },
    llm: { render: () => deferredTab(<LlmTab />) },
    voice: { render: () => deferredTab(<VoiceTab />) },
    'account-provider': { render: () => deferredTab(<AccountProviderTab />) },
    runtime: { render: () => deferredTab(<RuntimeTab />) },
    usage: { render: () => deferredTab(<UsageTab />) },
    'audit-log': { render: () => deferredTab(<AuditLogTab />) },
  }

  const groups: SettingsPageSectionGroup[] = settingsGroupsFor(audience).map(({ label, pages }) => ({
    label,
    sections: pages.map((page) => ({
      id: page.id,
      label: page.label,
      icon: <AnimatedNavIcon name={page.icon} className="h-4 w-4" />,
      ...content[page.id],
    })),
  }))

  return (
    <SettingsPage
      groups={groups}
      onClose={onClose}
      initialSection={initialSection}
      onSectionChange={onSectionChange}
      sectionLinkProps={sectionLinkProps}
      data-testid="global-settings-page"
      navTestIdPrefix="settings"
    />
  )
}
