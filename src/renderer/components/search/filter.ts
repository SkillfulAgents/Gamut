import type { ApiAgentDashboard, ApiSession } from '@shared/lib/types/api'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import type { SettingsPageEntry } from '@renderer/components/settings/settings-catalog'
import { searchSettings, type SettingsResult } from './settings-match'

export interface DashboardResult {
  agent: ApiAgent
  dashboard: ApiAgentDashboard
}

export interface SessionResult {
  agent: ApiAgent
  session: ApiSession
}

/**
 * What the search dialog lists, one array per section. A section with nothing
 * in it is not drawn.
 */
export interface SearchSections {
  agents: ApiAgent[]
  sessions: SessionResult[]
  dashboards: DashboardResult[]
  /** Settings pages, which only a query lists. */
  settings: SettingsResult[]
}

export type FlatItem =
  | { kind: 'agent'; agent: ApiAgent }
  | { kind: 'dashboard'; agent: ApiAgent; dashboard: ApiAgentDashboard }
  | { kind: 'session'; agent: ApiAgent; session: ApiSession }
  | { kind: 'settings'; result: SettingsResult }

/** How many rows "Recent agents" and "Recent sessions" show before a query is typed. */
export const RECENT_AGENTS_LIMIT = 5
export const RECENT_SESSIONS_LIMIT = 10

function getAgentDashboards(agent: ApiAgent): ApiAgentDashboard[] {
  return Array.isArray(agent.dashboards) ? agent.dashboards : []
}

function time(date: Date | string | null | undefined): number {
  return date ? new Date(date).getTime() : 0
}

/**
 * Newest first, in a new array. Each row's time is read once, not on every
 * comparison: the sort runs over every session of every agent.
 */
function newestFirst(results: SessionResult[]): SessionResult[] {
  return results
    .map((result) => ({ result, at: time(result.session.lastActivityAt) }))
    .sort((a, b) => b.at - a.at)
    .map(({ result }) => result)
}

/**
 * What the dialog shows before anything is typed: the most recently active
 * agents, and the most recently active sessions across every agent.
 */
export function getRecent(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  limits: { agents: number; sessions: number } = { agents: RECENT_AGENTS_LIMIT, sessions: RECENT_SESSIONS_LIMIT }
): SearchSections {
  const recentAgents = agents
    .filter((a) => a.lastActivityAt)
    .sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt))
    .slice(0, limits.agents)
  const recentSessions = newestFirst(
    agents.flatMap((agent) => (sessionsByAgent[agent.slug] ?? []).map((session) => ({ agent, session })))
  ).slice(0, limits.sessions)
  return { agents: recentAgents, sessions: recentSessions, dashboards: [], settings: [] }
}

/**
 * Filter agents, sessions, and dashboards by a substring query. Case-insensitive.
 *
 * Each kind is matched on its own name: an agent whose name does not match is
 * not listed because one of its sessions does. Sessions come newest first.
 * Settings pages (only those in `settingsPages`, the ones this viewer has) are
 * matched and ranked by `searchSettings`.
 */
export function searchAll(
  agents: ApiAgent[],
  sessionsByAgent: Record<string, ApiSession[]>,
  query: string,
  settingsPages: readonly SettingsPageEntry[] = []
): SearchSections {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return { agents: [], sessions: [], dashboards: [], settings: [] }
  const matches = (text: string) => text.toLowerCase().includes(trimmed)
  return {
    agents: agents.filter((agent) => matches(agent.name)),
    sessions: newestFirst(
      agents.flatMap((agent) =>
        (sessionsByAgent[agent.slug] ?? [])
          .filter((s) => matches(s.name))
          .map((session) => ({ agent, session }))
      )
    ),
    dashboards: agents.flatMap((agent) =>
      getAgentDashboards(agent)
        .filter((d) => matches(d.name) || matches(d.slug))
        .map((dashboard) => ({ agent, dashboard }))
    ),
    settings: searchSettings(settingsPages, query),
  }
}

/**
 * The sections in the order they are drawn, as the linear list keyboard
 * navigation walks. Settings come last: they never push the person's own
 * agents, sessions and dashboards down, nor change which of them Enter opens.
 */
export function flattenSections(sections: SearchSections): FlatItem[] {
  return [
    ...sections.agents.map<FlatItem>((agent) => ({ kind: 'agent', agent })),
    ...sections.sessions.map<FlatItem>(({ agent, session }) => ({ kind: 'session', agent, session })),
    ...sections.dashboards.map<FlatItem>(({ agent, dashboard }) => ({ kind: 'dashboard', agent, dashboard })),
    ...sections.settings.map<FlatItem>((result) => ({ kind: 'settings', result })),
  ]
}
