/**
 * The person's left-nav sections as the agent's `/workspace/sidebar.json`.
 * The container refreshes the file before every read of it and sends every
 * change back; the host owns both ends. Sections are that person's own view
 * (see `agent-folders.ts`), so nobody else's sidebar moves. A change applies
 * only when the file it started from still matches the stored sidebar, checked
 * inside the settings write, so a copy gone stale (a drag in the app, another
 * person's session in the same agent) is refused, never merged.
 */
import { z } from 'zod'
import { isAuthMode } from '@shared/lib/auth/mode'
import { listAgents } from '@shared/lib/services/agent-service'
import { getAccessibleAgentSlugs } from '@shared/lib/services/notification-service'
import { evaluate } from '@shared/lib/services/x-agent-policy-service'
import { globalFeed } from '@shared/lib/notifications/global-feed'
import {
  getUserSettingsForUsers,
  updateUserSettings,
  type UserSettingsData,
  type UserSettingsWrite,
} from '@shared/lib/services/user-settings-service'
import type { AgentRecord } from '@shared/lib/agent-actor/types'
import { applyAgentOrder } from '@shared/lib/utils/agent-order'
import { displaySlug } from '@shared/lib/utils/file-storage'
import {
  buildFolderSections,
  folderHeading,
  ROOT_FOLDER_ID,
  ROOT_FOLDER_NAME,
  sectionsToSettings,
  type FolderSection,
} from '@shared/lib/utils/agent-folders'
import { callerVisibleAgentSlugs, checkCallerPolicy, personBehindCall, type XAgentCaller } from './caller'
import { fail, sectionsWithIds, type XAgentErrorStatus, type XAgentResult } from './operations'

// The container checks the same rules for the agent's message: agent-container/src/file-hooks/sidebar-schema.ts.
// The shape alone: what the host wrote for a stored sidebar, whatever names it holds.
const sidebarFileShape = z.array(z.object({ id: z.string(), name: z.string(), agents: z.array(z.string()) }))

export const sidebarFileSchema = z.array(z.object({
  id: z.string().min(1).max(100),
  name: z.string(),
  agents: z.array(z.string().min(1)).max(1000),
})).max(200).superRefine((sections, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (sections.filter((s) => s.id === ROOT_FOLDER_ID).length !== 1) issue(`Exactly one section must have the id "${ROOT_FOLDER_ID}" (Your Agents).`)
  if (sections.some((s) => s.id === ROOT_FOLDER_ID && s.name !== ROOT_FOLDER_NAME)) issue(`The "${ROOT_FOLDER_ID}" section is always named "${ROOT_FOLDER_NAME}".`)
  if (new Set(sections.map((s) => s.id)).size !== sections.length) issue('Two sections share an id.')
  const agents = sections.flatMap((s) => s.agents)
  if (new Set(agents).size !== agents.length) issue('An agent is listed in more than one place.')
})
export type SidebarFile = z.infer<typeof sidebarFileShape>

const MAX_SECTION_NAME = 200

/** A change the stored sections cannot take; nothing is written. `reply` goes to the calling agent only. */
export class SectionChangeRefused extends Error {
  constructor(readonly status: XAgentErrorStatus, readonly reply: string) {
    super('Sidebar section change refused')
  }
}

/** The agents one person's sidebar lists, and which of them the calling agent may see and name. */
type SidebarAgent = Pick<AgentRecord, 'slug' | 'createdAt'>

export interface SidebarScope {
  sidebar: SidebarAgent[]
  /** Stored slug to the slug the file shows, for the agents the caller can list (itself included). */
  shown: Map<string, string>
}

export async function readSidebarFile(caller: XAgentCaller): Promise<XAgentResult<{ sections: SidebarFile } | { sections: null; reason: string }>> {
  // The person first: a run nobody is behind raises no card that nobody could answer.
  const userId = await personBehindCall(caller)
  if (!userId) return { ok: true, value: { sections: null, reason: 'The app could not identify a person behind this session, so there is no sidebar to show. Sections belong to the person you are working for.' } }
  // The file shows the roster, so it passes the list_agents gate.
  const policy = await checkCallerPolicy(caller, 'list', null, 'all agents')
  if (!policy.allowed) return { ok: true, value: { sections: null, reason: policy.reason ?? 'Listing agents was not allowed for this agent, so the sidebar is not shown.' } }
  const [scope, settings] = await Promise.all([scopeFor(caller, userId), storedSettings(userId)])
  return { ok: true, value: { sections: sidebarFileOf(scope, settings) } }
}

export async function writeSidebarFile(
  caller: XAgentCaller,
  before: string | null,
  after: string,
): Promise<XAgentResult<{ sections: SidebarFile }>> {
  const userId = await personBehindCall(caller)
  if (!userId) {
    return fail(409, 'No person wrote in this session, so there is no sidebar to change. Sections change only for the person you are working for.')
  }
  // No card on the write: a matching `before` means the caller already holds these sections, so the applied ones it gets back show nothing new.
  if (caller.kind === 'agent' && (await evaluate(caller.agentSlug, 'list', null)) === 'block') {
    return fail(403, 'Listing agents is blocked for this agent, so it cannot change the sidebar.')
  }
  const next = parseSidebarFile(after, sidebarFileSchema)
  if (!next.ok) return fail(400, `sidebar.json was not applied: ${next.error}`)
  // `before` is checked against the stored sidebar, not the rules for a new file.
  const seen = before === null ? null : parseSidebarFile(before, sidebarFileShape)
  const scope = await scopeFor(caller, userId)
  try {
    let previous = ''
    const updated = await updateUserSettings(userId, (current) => {
      previous = sectionFieldsOf(current)
      return applySidebarFile(scope, current, seen?.ok ? seen.value : null, next.value)
    })
    // The person's open apps refetch, so their sidebar redraws; a change that moved nothing sends nothing.
    if (sectionFieldsOf(updated) !== previous) globalFeed.publishToUsers([userId], { type: 'user_settings_changed' })
    // What was applied, so the copy can match it (an agent left out moved, a name lost its line breaks).
    return { ok: true, value: { sections: sidebarFileOf(scope, updated) } }
  } catch (error) {
    if (error instanceof SectionChangeRefused) return fail(error.status, error.reply)
    throw error
  }
}

/** The file for these settings: the sidebar's own sections, over the agents the caller can list. */
export function sidebarFileOf(scope: SidebarScope, settings: UserSettingsData): SidebarFile {
  const listed = scope.sidebar.filter((a) => scope.shown.has(a.slug))
  return sectionsWithIds(listed, listed.map((a) => scope.shown.get(a.slug)!), settings)
}

/** The settings write that makes the stored sidebar equal `after`; throws {@link SectionChangeRefused}. */
export function applySidebarFile(
  scope: SidebarScope,
  current: UserSettingsData,
  before: SidebarFile | null,
  after: SidebarFile,
): UserSettingsWrite {
  if (!before || JSON.stringify(before) !== JSON.stringify(sidebarFileOf(scope, current))) {
    throw new SectionChangeRefused(409, 'The sidebar changed since sidebar.json was read. Read it again, then redo the change.')
  }
  const sections = sectionsOf(scope, current)
  const stored = new Map(sections.map((s) => [s.folder.id, s]))
  const bySlug = new Map(scope.sidebar.map((r) => [r.slug, r]))
  const byShown = new Map([...scope.shown].map(([slug, shown]) => [shown, slug]))
  const hidden = (slug: string) => !scope.shown.has(slug)

  const unknown = after.flatMap((s) => s.agents).filter((shown) => !byShown.has(shown))
  if (unknown.length) throw new SectionChangeRefused(404, `No agent you can list matches: ${unknown.join(', ')}. Use the slugs sidebar.json shows.`)
  const kept = new Set(after.map((s) => s.id))
  for (const s of sections) {
    if (!kept.has(s.folder.id) && s.agents.some((a) => hidden(a.slug))) {
      throw new SectionChangeRefused(409, `"${folderHeading(s.folder.name)}" holds agents you cannot list, so it cannot be deleted.`)
    }
  }

  // Name rules bind only what this change names: a stored name the app once saved stays as it is.
  for (const { id, name } of after) {
    const old = stored.get(id)
    if (id === ROOT_FOLDER_ID || (old && name === folderHeading(old.folder.name))) continue
    const heading = folderHeading(name)
    if (!heading || heading.length > MAX_SECTION_NAME) throw new SectionChangeRefused(400, `A section name needs 1 to ${MAX_SECTION_NAME} characters.`)
  }

  const placed = new Set(after.flatMap((s) => s.agents).map((shown) => byShown.get(shown)))
  const next: FolderSection<SidebarAgent>[] = after.map(({ id, name, agents }) => {
    const old = stored.get(id)
    const listed = agents.map((shown) => bySlug.get(byShown.get(shown)!)!)
    // Agents the caller cannot see keep their place in a section that stays.
    old?.agents.forEach((a, i) => { if (hidden(a.slug)) listed.splice(Math.min(i, listed.length), 0, a) })
    const isRoot = id === ROOT_FOLDER_ID
    // The file shows names on one line: an unchanged one keeps what is stored.
    const storedName = isRoot ? ROOT_FOLDER_NAME : old && name === folderHeading(old.folder.name) ? old.folder.name : folderHeading(name)
    return { folder: { id, name: storedName }, isRoot, agents: listed }
  })
  // An agent left out of the file goes to Your Agents, as deleting its section does.
  const leftOut = sections.flatMap((s) => s.agents).filter((a) => !hidden(a.slug) && !placed.has(a.slug))
  const root = next.find((s) => s.isRoot)!
  root.agents.push(...leftOut)

  const collapsed = current.collapsedAgentFolders?.filter((id) => kept.has(id))
  return {
    ...sectionsToSettings(next),
    ...(collapsed && collapsed.length !== current.collapsedAgentFolders?.length && { collapsedAgentFolders: collapsed }),
  }
}

async function scopeFor(caller: XAgentCaller, userId: string): Promise<SidebarScope> {
  const [records, visible, filed] = await Promise.all([
    listAgents(),
    callerVisibleAgentSlugs(caller),
    // The agents the person's sidebar lists, as the agents route returns them: every agent they hold a role on.
    isAuthMode() ? getAccessibleAgentSlugs(userId).then((slugs) => new Set(slugs)) : null,
  ])
  const sidebar = records.filter((r) => !filed || filed.has(r.slug))
  // Named as list_agents prints them; the calling agent may file itself.
  const nameable = sidebar.filter((r) => !visible || visible.has(r.slug) || (caller.kind === 'agent' && r.slug === caller.agentSlug))
  return { sidebar, shown: new Map(nameable.map((r) => [r.slug, displaySlug(r.name, r.slug)])) }
}

// Read only: reading the file must not create a settings row for the person.
async function storedSettings(userId: string): Promise<UserSettingsData> {
  return (await getUserSettingsForUsers([userId])).get(userId)!
}

function sectionsOf(scope: SidebarScope, settings: UserSettingsData): FolderSection<SidebarAgent>[] {
  return buildFolderSections(
    applyAgentOrder(scope.sidebar, settings.agentOrder),
    settings.agentFolders,
    settings.agentFolderAssignments,
    settings.agentListOrder,
  )
}

function parseSidebarFile(text: string, schema: z.ZodType<SidebarFile>): { ok: true; value: SidebarFile } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'it is not valid JSON.' }
  }
  const result = schema.safeParse(parsed)
  if (result.success) return { ok: true, value: result.data }
  return { ok: false, error: result.error.issues.map((i) => i.message).join(' ') }
}

function sectionFieldsOf(s: UserSettingsData): string {
  return JSON.stringify([s.agentFolders, s.agentFolderAssignments, s.agentListOrder, s.agentOrder, s.collapsedAgentFolders])
}
