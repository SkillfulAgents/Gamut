import { useUser } from '@renderer/context/user-context'
import { offersComputerUseSettings } from '@renderer/lib/capabilities'
import type { AnimatedNavIconName } from '@renderer/components/ui/animated-nav-icon'
import type { SettingsTab } from '@renderer/router/search-schemas'

/**
 * Every global settings page: its name, icon and group in the settings nav,
 * who has it, and what else someone might type to find it. The settings nav
 * (`global-settings-page.tsx`) and the Cmd-K palette both read this list, so a
 * page the palette offers is always one the nav shows that viewer.
 */

export const SETTINGS_GROUPS = [
  'App Settings',
  'Agent Capabilities',
  'Agent Infrastructure',
  'Agent Activity',
] as const
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/** What decides which pages a viewer has. */
export interface SettingsAudience {
  isAuthMode: boolean
  isAdmin: boolean
  /** `offersComputerUseSettings()`: the agents run on this computer, and it is not a sandboxed build. */
  computerUse: boolean
}

export interface SettingsPageEntry {
  id: SettingsTab
  label: string
  icon: AnimatedNavIconName
  group: SettingsGroup
  /** Whether this viewer has the page. Omitted: everyone does. */
  shownTo?: (audience: SettingsAudience) => boolean
  /**
   * What else someone might type for this page: the settings on it, the
   * services it configures, and other names for what it does. Written as they
   * should read, since the palette shows the one a query matched. One may name
   * something only some viewers see on the page; the page is still where it
   * would be.
   */
  keywords: readonly string[]
}

// Local mode has no roles, so everyone there is treated as the admin.
const admins = ({ isAuthMode, isAdmin }: SettingsAudience) => !isAuthMode || isAdmin
const authAdmins = ({ isAuthMode, isAdmin }: SettingsAudience) => isAuthMode && isAdmin

// Grouped by what the setting concerns (app-level vs agent behavior), not by
// who can edit it: admin-only pages are filtered per page instead. Within a
// group this is the nav order. General always leads App Settings and Admin
// always trails it; the mode-gated pages sit between those two anchors.
export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  // App Settings
  {
    id: 'general', label: 'General', icon: 'general', group: 'App Settings',
    keywords: [
      'Preferences', 'Appearance', 'Theme', 'Dark mode', 'Light mode', 'Timezone',
      'Menu bar', 'System tray', 'Keep awake', 'Keyboard shortcuts', 'Quick Dispatch',
      'Branding', 'Web icon', 'Favicon', 'Privacy', 'Error reports', 'Anonymous analytics',
      'Session auto-delete', 'API log auto-delete', 'Setup wizard', 'Software updates',
      'Check for updates', 'Pre-release versions',
    ],
  },
  {
    id: 'notifications', label: 'Notifications', icon: 'bell', group: 'App Settings',
    keywords: [
      'Alerts', 'Push notifications', 'Desktop notifications', 'Action required',
      'Session complete', 'Scheduled task started', 'Test notifications',
    ],
  },
  {
    id: 'platform', label: 'Account', icon: 'account', group: 'App Settings',
    keywords: [
      'Gamut account', 'Profile', 'Email', 'Password', 'Plan', 'Subscription', 'Billing',
      'Credits', 'Organization', 'Workspace', 'Cloud agents', 'Delete account',
    ],
  },
  // Everyone: each switch is the viewer's own.
  {
    id: 'experiments', label: 'Experiments', icon: 'experiments', group: 'App Settings',
    keywords: ['Beta features', 'Experimental features', 'Labs', 'Feature flags'],
  },
  {
    id: 'analytics', label: 'Analytics', icon: 'analytics', group: 'App Settings',
    shownTo: authAdmins,
    keywords: ['Analytics targets', 'Amplitude', 'Mixpanel', 'Google Analytics', 'Tracking'],
  },
  // Its people are offered when sharing and mentioning (auth mode), and it can
  // create agents' own apps (every mode).
  {
    id: 'team-directory', label: 'Team Directory', icon: 'directory', group: 'App Settings',
    shownTo: admins,
    keywords: ['Slack', 'People', 'Mentions', 'Sharing', 'Agent apps', 'Slack apps'],
  },
  {
    id: 'users', label: 'Users', icon: 'users', group: 'App Settings',
    shownTo: authAdmins,
    keywords: [
      'Members', 'Team members', 'Invite', 'Invitations', 'Roles', 'Pending approval',
      'Ban user', 'Reset password',
    ],
  },
  {
    id: 'auth', label: 'Auth', icon: 'shield', group: 'App Settings',
    shownTo: authAdmins,
    keywords: [
      'Authentication', 'Security', 'Sign-up', 'Signup mode', 'Social login',
      'Password policy', 'Lockout', 'Session timeout', 'Trusted origins',
      'Allowed signup domains', 'Invitation only', 'Admin approval', 'Default user role',
    ],
  },
  {
    id: 'admin', label: 'Admin', icon: 'shield', group: 'App Settings',
    shownTo: admins,
    keywords: ['Danger zone', 'Factory reset', 'Delete all data'],
  },

  // Agent Capabilities: what agents can do or reach.
  // Pairing mints a session credential against THIS deployment's auth, so the
  // page only exists in auth mode: a local install has no session to pair.
  {
    id: 'mobile', label: 'Mobile', icon: 'mobile', group: 'Agent Capabilities',
    shownTo: ({ isAuthMode }) => isAuthMode,
    keywords: ['Mobile app', 'Phone', 'iPhone', 'Pair device', 'Paired devices', 'QR code'],
  },
  {
    id: 'connections', label: 'Connections', icon: 'connections', group: 'Agent Capabilities',
    keywords: [
      'Integrations', 'Connected accounts', 'Apps', 'OAuth', 'MCP servers', 'Tools',
      'Tool policy', 'API request policy',
    ],
  },
  // Everyone: external agents (Claude Code, Codex, Cursor, Claude) working
  // with this workspace. In auth mode each person connects their own tools
  // (OAuth) and lists them here; the switch inside is the admin's.
  {
    id: 'mcp-server', label: 'MCP Server', icon: 'plug', group: 'Agent Capabilities',
    keywords: [
      'Claude Code', 'Codex', 'Cursor', 'AI tools', 'External agents', 'MCP endpoint',
      'MCP token', 'Connect a client', 'Connected clients',
    ],
  },
  {
    id: 'volumes', label: 'Drives', icon: 'folder', group: 'Agent Capabilities',
    keywords: [
      'Volumes', 'Storage', 'Files', 'Folders', 'Local folder', 'Google Drive', 'Dropbox',
      'S3 bucket', 'GitHub', 'Mounts',
    ],
  },
  // Everyone: each user's vault is their own.
  {
    id: 'logins', label: 'Logins', icon: 'key', group: 'Agent Capabilities',
    keywords: [
      'Saved logins', 'Passwords', 'Passkeys', 'Authenticator app', 'Two-factor', '2FA',
      'Browser vault', 'Credentials',
    ],
  },
  {
    id: 'skillsets', label: 'Skillsets', icon: 'layers', group: 'Agent Capabilities',
    shownTo: admins,
    keywords: ['Skills', 'Skill repositories', 'GitHub repository', 'Repository token'],
  },
  {
    id: 'web', label: 'Web Search', icon: 'search', group: 'Agent Capabilities',
    shownTo: admins,
    keywords: ['Search provider', 'Web provider', 'Exa', 'You.com', 'Parallel', 'SpecStream', 'API keys'],
  },
  {
    id: 'browser', label: 'Browser Use', icon: 'pointer', group: 'Agent Capabilities',
    shownTo: admins,
    keywords: [
      'Web browsing', 'Browser agent', 'Browser agent model', 'Browser host', 'Chrome',
      'Chromium', 'Headless mode', 'Max browser tabs', 'Stealth mode', 'CAPTCHA solving',
      'Proxies', 'Residential proxies', 'Browserbase', 'Steel', 'Tab Tender',
      'Password managers', 'High-resolution rendering', 'API keys',
    ],
  },
  // Computer Use drives the machine the agent runs on, and its whole UI
  // (permission grants, the recovery link into System Settings) is written for
  // that machine being yours. `isElectron()` stays true in cloud mode while
  // execution moves to the deployment, so the page would describe your laptop
  // and govern someone else's. A sandboxed build has no computer use to govern.
  {
    id: 'computer-use', label: 'Computer Use', icon: 'mouse', group: 'Agent Capabilities',
    shownTo: (audience) => admins(audience) && audience.computerUse,
    keywords: [
      'Desktop control', 'Screen control', 'Agent cursor', 'Physical input',
      'Persistent permissions', 'Accessibility',
    ],
  },
  {
    id: 'capabilities', label: 'Subagents', icon: 'workflow', group: 'Agent Capabilities',
    shownTo: admins,
    keywords: ['Workflows', 'Launch policies', 'Capabilities'],
  },
  // Everyone: what every agent is told is visible to all; the editor is
  // read-only for non-admins.
  {
    id: 'global-guidance', label: 'Global Guidance', icon: 'guidance', group: 'Agent Capabilities',
    keywords: ['Global instructions', 'Custom instructions', 'System prompt', 'Rules'],
  },
  // Everyone: the page carries each person's own read-aloud voice; the
  // provider and key sections on it are admin-gated.
  {
    id: 'llm', label: 'Model Providers', icon: 'sparkle', group: 'Agent Capabilities',
    keywords: [
      'LLM', 'Models', 'Model catalog', 'Provider connections', 'API keys', 'Anthropic',
      'Claude', 'Claude subscription', 'OpenAI', 'ChatGPT', 'Codex', 'Amazon Bedrock', 'AWS',
      'Ollama', 'Local models', 'OpenRouter', 'Grok', 'Kimi', 'MiniMax', 'Qwen', 'DeepSeek',
      'Summarizer',
    ],
  },
  {
    id: 'voice', label: 'Voice', icon: 'mic', group: 'Agent Capabilities',
    keywords: [
      'Voice mode', 'Speech-to-text', 'Text-to-speech', 'Dictation', 'Read aloud',
      'Default voice', 'Microphone', 'Hold sound', 'Deepgram', 'OpenAI', 'API keys',
    ],
  },

  // Agent Infrastructure: the plumbing agents run on, mostly set once.
  {
    id: 'account-provider', label: 'Account Provider', icon: 'route', group: 'Agent Infrastructure',
    shownTo: admins,
    keywords: ['Composio', 'Nango', 'OAuth provider', 'Integrations provider'],
  },
  {
    id: 'runtime', label: 'Container Runtime', icon: 'runtime', group: 'Agent Infrastructure',
    shownTo: admins,
    keywords: [
      'Docker', 'Podman', 'Lima', 'WSL', 'Containers', 'Agent image', 'CPU limit',
      'Memory limit', 'Idle timeout', 'Auto-sleep', 'Max turns', 'Max budget',
      'Max output tokens', 'Max thinking tokens', 'Environment variables', 'Data location',
      'Warm start', 'Auto-resume',
    ],
  },

  // Agent Activity: read-only places you check, not configure.
  {
    id: 'usage', label: 'Usage', icon: 'usage', group: 'Agent Activity',
    keywords: ['Cost', 'Spend', 'Estimated spend', 'Tokens', 'Usage by model', 'Usage by agent'],
  },
  {
    id: 'audit-log', label: 'Audit Log', icon: 'logs', group: 'Agent Activity',
    shownTo: admins,
    keywords: ['Activity log', 'Audit trail', 'Events', 'History'],
  },
]

/** The pages this viewer has, in nav order. */
export function settingsPagesFor(audience: SettingsAudience): SettingsPageEntry[] {
  return SETTINGS_PAGES.filter((page) => page.shownTo?.(audience) ?? true)
}

/**
 * The pages this viewer has, by group in nav order. A group with no pages for
 * them (Agent Infrastructure, for a member in auth mode) is left out, so the nav
 * draws no orphaned header.
 */
export function settingsGroupsFor(
  audience: SettingsAudience,
): Array<{ label: SettingsGroup; pages: SettingsPageEntry[] }> {
  const pages = settingsPagesFor(audience)
  return SETTINGS_GROUPS
    .map((label) => ({ label, pages: pages.filter((page) => page.group === label) }))
    .filter((group) => group.pages.length > 0)
}

/** This viewer's audience, as the nav and the palette both decide it. */
export function useSettingsAudience(): SettingsAudience {
  const { isAuthMode, isAdmin } = useUser()
  return { isAuthMode, isAdmin, computerUse: offersComputerUseSettings() }
}
