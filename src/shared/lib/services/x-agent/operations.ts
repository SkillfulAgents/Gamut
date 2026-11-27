/**
 * The cross-agent read operations: list agents, list a target's sessions, read
 * a session's transcript, open a delivered file. Each acts for an
 * {@link XAgentCaller} and returns what the caller gets, or the refusal with
 * the HTTP status the agent-facing routes have always answered it with.
 */
import { eq } from 'drizzle-orm'
import { inList } from '@shared/lib/db/bound-parameters'
import { db } from '@shared/lib/db'
import { agentConnectedAccounts, connectedAccounts } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { listAgents } from '@shared/lib/services/agent-service'
import { listAgentMembersByAgent } from '@shared/lib/services/agent-members-service'
import { listAgentShares } from '@shared/lib/services/agent-sharing-service'
import type { AgentMember } from '@shared/lib/agent-members-schema'
import type { MemberAgent } from '@shared/lib/types/agent-sharing'
import type { AgentListing, AgentRecord } from '@shared/lib/agent-actor/types'
import { isHiddenAutomatedSession } from '@shared/lib/services/session-visibility'
import { displaySlug } from '@shared/lib/utils/file-storage'
import { agentCatalog, agentRegistry } from '@shared/lib/agent-actor'
import {
  normalizeXAgentAttachmentPaths,
  openXAgentFile,
  transferError,
  XAgentAttachmentError,
} from '@shared/lib/services/x-agent-attachment-service'
import type { TranscriptView } from '@shared/lib/services/x-agent-transcript-view'
import type { SessionMetadata } from '@shared/lib/types/agent'
import {
  callerHasRoleOnTarget,
  callerVisibleAgentSlugs,
  checkCallerPolicy,
  startPolicyRead,
  startRead,
  type XAgentCaller,
} from './caller'
import { effectiveSyncWaitMs, readLastAssistantMessage, waitForTurnWithinBudget } from './sync-wait'

export type XAgentErrorStatus = 400 | 403 | 404 | 409 | 413 | 500 | 502 | 504

/** A refusal or failure, with the status the routes answer it with. */
export interface XAgentFailure {
  ok: false
  status: XAgentErrorStatus
  error: string
}

export type XAgentResult<T> = { ok: true; value: T } | XAgentFailure

export function fail(status: XAgentErrorStatus, error: string): XAgentFailure {
  return { ok: false, status, error }
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

// ----------------------------------------------------------------------------
// list - agents visible to caller
// ----------------------------------------------------------------------------

type ListedAgentMember = Pick<AgentMember, 'name' | 'role' | 'invited'> & { kind: 'person' | 'agent' }

export interface ListedAgent {
  slug: string
  name: string
  description: string | undefined
  createdAt: Date
  /** People first, then member agents, capped at MAX_RESUME_MEMBERS; memberCount is the full total. */
  members: ListedAgentMember[]
  memberCount: number
  running: boolean
  needsInput: boolean
  lastActivityAt: Date | null
  sessionCount: number
  automatedSessionCount: number
  dashboards: string[]
  /** Toolkits the agent has accounts for (gmail, slack), whatever their status: never the accounts, as the app shows another person's account. */
  accountServices: string[]
}

// Bounds each entry's roster; the full one stays a list_agent_members call away for the caller's own agent.
const MAX_RESUME_MEMBERS = 25

export async function listVisibleAgents(caller: XAgentCaller): Promise<XAgentResult<{ agents: ListedAgent[] }>> {
  const policy = await checkCallerPolicy(caller, 'list', null, 'all agents')
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  const visible = await callerVisibleAgentSlugs(caller)
  const records = (await listAgents())
    // An agent lists the others, not itself.
    .filter((a) => caller.kind !== 'agent' || a.slug !== caller.agentSlug)
    .filter((a) => (visible ? visible.has(a.slug) : true))
  const slugs = records.map((a) => a.slug)
  const [people, shares, services, listings] = await Promise.all([
    // People are members only with sign-in on, as list_agent_members.
    listAgentMembersByAgent(isAuthMode() ? slugs : []),
    listAgentShares(slugs, null),
    accountServicesByAgent(slugs),
    // The Home list's per-agent read: cached state, no container is woken.
    Promise.all(slugs.map((slug) => agentRegistry.get(slug).listing())),
  ])
  const agents = records.map((a, i) =>
    toListedAgent(a, listings[i], people[a.slug] ?? [],
      // As the app's member stack: only member agents the caller could list itself.
      (shares[a.slug]?.direct ?? []).filter((m) => !visible || visible.has(m.slug)),
      services.get(a.slug) ?? []))
  return ok({ agents })
}

export function toListedAgent(
  record: AgentRecord,
  { live, sessions, artifacts }: AgentListing,
  people: AgentMember[],
  memberAgents: MemberAgent[],
  accountServices: string[],
): ListedAgent {
  const members: ListedAgentMember[] = [
    ...people.map(({ name, role, invited }) => ({ name, role, invited, kind: 'person' as const })),
    ...memberAgents.map(({ name, role }) => ({ name, role, kind: 'agent' as const })),
  ]
  return {
    // Project the decorative display slug for the model; the catalog tolerates
    // it (and the bare id / legacy form) on the way back in via invoke/get-*.
    slug: displaySlug(record.name, record.slug),
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    members: members.slice(0, MAX_RESUME_MEMBERS),
    memberCount: members.length,
    running: live.activeSessionIds.length > 0,
    // As the Home list: a proxy review waits on the user too, session or not.
    needsInput: live.awaitingSessionIds.length > 0 || live.pendingReviews.length > 0,
    lastActivityAt: sessions.lastActivityAt,
    sessionCount: sessions.sessionCount,
    automatedSessionCount: sessions.sessionIds.filter((id) => isHiddenAutomatedSession(sessions.metadata[id])).length,
    dashboards: artifacts.dashboards.map((d) => d.name || d.slug),
    accountServices,
  }
}

async function accountServicesByAgent(slugs: string[]): Promise<Map<string, string[]>> {
  if (!slugs.length) return new Map()
  const rows = await db
    .selectDistinct({ agentSlug: agentConnectedAccounts.agentSlug, toolkit: connectedAccounts.toolkitSlug })
    .from(agentConnectedAccounts)
    .innerJoin(connectedAccounts, eq(agentConnectedAccounts.connectedAccountId, connectedAccounts.id))
    .where(inList(agentConnectedAccounts.agentSlug, slugs))
    .orderBy(connectedAccounts.toolkitSlug)
  return new Map([...Map.groupBy(rows, (row) => row.agentSlug)].map(([slug, entries]) => [slug, entries.map((row) => row.toolkit)]))
}

// ----------------------------------------------------------------------------
// get-sessions - list sessions of a target agent
// ----------------------------------------------------------------------------

export interface ListedSession {
  id: string
  name: string
  createdAt: Date
  lastActivityAt: Date
  isRunning: boolean
}

export async function getTargetSessions(
  caller: XAgentCaller,
  input: {
    slug: string
    limit: number
    offset: number
    /**
     * List what the app's own session list shows: automated sessions (scheduled,
     * webhook, called from other agents, …) only once promoted to interactive.
     * The agent route lists every session.
     */
    excludeAutomated?: boolean
    /**
     * With `excludeAutomated`: hidden sessions this caller may still see
     * listed (the MCP server: the ones the person started through it).
     */
    alsoIncludeHidden?: (metadata: SessionMetadata) => boolean
  },
): Promise<XAgentResult<{ sessions: ListedSession[]; total: number; offset: number; limit: number }>> {
  const { slug: rawTargetSlug, limit, offset, excludeAutomated, alsoIncludeHidden } = input

  // Resolve the model-supplied display slug to the agent and rebind, so every
  // downstream ACL / policy / fs use below keys on the id, not the prefix.
  const target = await agentCatalog.resolveRecord(rawTargetSlug)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug

  const access = startRead(callerHasRoleOnTarget(caller, targetSlug, 'viewer'))
  const savedDecision = startPolicyRead(caller, 'read', targetSlug)
  if (!(await access)) {
    return fail(403, 'Forbidden: caller has no access to target agent')
  }

  const policy = await checkCallerPolicy(caller, 'read', targetSlug, target.name, { savedDecision })
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  const actor = agentRegistry.get(targetSlug)
  let allSessions = excludeAutomated && !alsoIncludeHidden
    ? await actor.sessions.list({ excludeAutomated: true })
    : await actor.sessions.list()
  if (excludeAutomated && alsoIncludeHidden) {
    const metadata = await actor.sessions.readMetadata()
    allSessions = allSessions.filter((session) => {
      const meta = metadata[session.id]
      return !isHiddenAutomatedSession(meta) || (!!meta && alsoIncludeHidden(meta))
    })
  }
  const page = allSessions.slice(offset, offset + limit)
  const active = new Set((await actor.live()).activeSessionIds)
  return ok({
    sessions: page.map((s) => ({
      id: s.id,
      name: s.name,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      isRunning: active.has(s.id),
    })),
    total: allSessions.length,
    offset,
    limit,
  })
}

// ----------------------------------------------------------------------------
// get-transcript - read transcript for a target session
// ----------------------------------------------------------------------------

export interface GetTranscriptInput {
  slug: string
  sessionId: string
  sync?: boolean
  // Most recent N view-rows. Omitted = the whole view.
  limit?: number
  // Default quiet: spoken turns, internals collapsed. true = today's compact view.
  fullTranscript?: boolean
  /**
   * How long a sync read may wait for a running turn, in ms. Clamped to
   * (0, the configured maximum]; absent = the maximum. Not on the agent route.
   * A value that is not a positive finite number also means the maximum: it is
   * never "don't wait". The budget runs from entry, so the reads before the
   * wait spend it too.
   */
  syncWaitMs?: number
}

export type TranscriptStatus = 'running' | 'idle' | 'awaiting_input'

export async function getTargetTranscript(
  caller: XAgentCaller,
  input: GetTranscriptInput,
): Promise<XAgentResult<{ status: TranscriptStatus } & TranscriptView>> {
  // Stamp the sync budget before any slow pre-work (policy review can block on
  // a human decision) so the total response time stays under the transport cap.
  const syncDeadline = Date.now() + effectiveSyncWaitMs(input.syncWaitMs)
  const { slug: rawTargetSlug, sessionId, sync, limit, fullTranscript } = input

  // Resolve the model-supplied display slug to the agent and rebind.
  const target = await agentCatalog.resolveRecord(rawTargetSlug)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug

  const access = startRead(callerHasRoleOnTarget(caller, targetSlug, 'viewer'))
  const savedDecision = startPolicyRead(caller, 'read', targetSlug)
  if (!(await access)) {
    return fail(403, 'Forbidden: caller has no access to target agent')
  }

  const policy = await checkCallerPolicy(caller, 'read', targetSlug, target.name, { savedDecision })
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  const actor = agentRegistry.get(targetSlug)

  // Status and wait state live in the target's live sessions. Validate the
  // target/session pair before consulting them, not only before reading the
  // target-scoped transcript below.
  if (!(await actor.sessions.isKnown(sessionId))) {
    return fail(404, 'Session not found')
  }

  if (sync && (await actor.sessions.live(sessionId)).isActive) {
    // Last reply flushed before we started waiting — used below to detect that
    // the turn we waited out has actually reached the transcript file.
    const boundaryEntry = await actor.messages.findLastEntry(sessionId, { kind: 'assistant' })
    try {
      // 'timeout' falls through: return the transcript so far with status
      // 'running'. Sync get-transcript is a bounded long-poll the caller can
      // repeat, not an unbounded wait — an unbounded wait would outlive the
      // container's 300s fetch header timeout and surface as a retry-inducing
      // network error. Other failures stay hard errors.
      const outcome = await waitForTurnWithinBudget(targetSlug, sessionId, syncDeadline)
      // The turn's 'result' event clears isActive before its final assistant
      // entry hits the JSONL file. When the turn we observed running has ended
      // — the wait said so, or it timed out and the turn ended in the gap
      // before the status read below — reconcile (bounded, ~5s) until an entry
      // newer than the pre-wait boundary appears, so an "idle" response
      // doesn't ship a transcript missing the reply it waited for.
      //
      // Deliberately gated on activity observed IN THIS REQUEST: the JSONL is
      // written by the container process, so the host has no write queue to
      // barrier on, and reconciling on every idle response would burn the full
      // poll budget on sessions that are simply idle. A session that went idle
      // just before the isSessionActive check above keeps plain read-what's-
      // flushed semantics.
      if (outcome === 'completed' || !(await actor.sessions.live(sessionId)).isActive) {
        await readLastAssistantMessage(targetSlug, sessionId, boundaryEntry?.uuid)
      }
    } catch (error) {
      return fail(504, `Session did not idle: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const live = await actor.sessions.live(sessionId)
  const status: TranscriptStatus = live.isAwaitingInput
    ? 'awaiting_input'
    : live.isActive
      ? 'running'
      : 'idle'

  const { messages, total, deliveredFiles } = await actor.messages.transcriptView(sessionId, { fullTranscript, limit })

  return ok({ status, messages, total, deliveredFiles })
}

// ----------------------------------------------------------------------------
// download-file - open a successful deliver_file output
// ----------------------------------------------------------------------------

export interface OpenedDeliveredFile {
  body: ReadableStream<Uint8Array>
  sizeBytes: number
  filename: string
}

export async function openDeliveredFile(
  caller: XAgentCaller,
  input: { slug: string; sessionId: string; deliveryId: string },
): Promise<XAgentResult<OpenedDeliveredFile>> {
  const { slug: rawTargetSlug, sessionId, deliveryId } = input
  const target = await agentCatalog.resolveRecord(rawTargetSlug)
  if (!target) return fail(404, 'Target agent not found')
  const targetSlug = target.slug
  // The policy is read where it always was, after the delivery is found: that
  // lookup parses a transcript, and a Block saved meanwhile must still apply.
  if (!(await callerHasRoleOnTarget(caller, targetSlug, 'viewer'))) {
    return fail(403, 'Forbidden: caller has no access to target agent')
  }
  const actor = agentRegistry.get(targetSlug)
  if (!(await actor.sessions.isKnown(sessionId))) {
    return fail(404, 'Session not found')
  }

  const delivery = await actor.messages.findDeliveredFile(sessionId, deliveryId)
  if (!delivery) return fail(404, 'Delivered file not found')
  const policy = await checkCallerPolicy(caller, 'read', targetSlug, target.name, {
    fileTransfer: { kind: 'download', filename: delivery.filename },
  })
  if (!policy.allowed) return fail(403, policy.reason ?? 'Forbidden')

  let sourcePath: string
  try {
    [sourcePath] = normalizeXAgentAttachmentPaths([delivery.filePath])
  } catch {
    return fail(400, 'Delivered file path is invalid')
  }
  try {
    const upstream = await openXAgentFile(actor.files, sourcePath)
    const currentSize = upstream.sizeBytes
    if (currentSize !== delivery.sizeBytes) {
      await upstream.body.cancel().catch(() => {})
      return fail(409, 'Delivered file changed after it was published')
    }
    return ok({ body: upstream.body, sizeBytes: currentSize, filename: delivery.filename })
  } catch (caught) {
    const error = transferError(caught)
    if (error instanceof XAgentAttachmentError) {
      return fail(error.status, error.status === 404 ? 'Delivered file is no longer available' : error.message)
    }
    return fail(502, 'Failed to read delivered file')
  }
}
