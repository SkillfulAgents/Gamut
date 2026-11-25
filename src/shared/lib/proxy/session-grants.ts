/**
 * "Allow for this session": what one session's proxied calls may do without a
 * review card, in AppState so every process that serves the tenant sees the
 * same grants.
 *
 * A grant names what the approved request matched (its API scopes, or its MCP
 * tool) on one account or MCP server. It moves a later request of that session
 * from `review` to `allow` and nothing else: a Block still blocks, and a proxy
 * rule that requires review still holds the request.
 *
 * Which session a request came from is the container's claim, not an auth
 * input. Whether that session is working right now, the other half of the
 * decision, is the agent's to say (`AgentReviews.sessionAllows`).
 */
import { appState, defineNamespace, reduceRecord, type StateKey } from '@shared/lib/app-state'
import {
  MAX_SESSION_GRANTS,
  sessionGrantsRecordSchema,
  type SessionGrant,
  type SessionGrantsRecord,
} from './session-grants-schema'

/** A session's grants are forgotten this long after its latest one. */
export const SESSION_GRANT_TTL_MS = 24 * 60 * 60 * 1000

const sessionGrants = defineNamespace({
  name: 'proxy:session-grants',
  consistency: 'strong',
  schema: sessionGrantsRecordSchema,
  expiry: { ttlMs: SESSION_GRANT_TTL_MS, onUpdate: 'reset' },
})

/** The session's grants key. For tests and diagnostics. */
export function sessionGrantsKey(agentSlug: string, sessionId: string): StateKey<SessionGrantsRecord, 'strong'> {
  return sessionGrants.key(agentSlug, sessionId)
}

/** The request a grant is made from, or checked against. */
export interface SessionGrantRequest {
  kind: SessionGrant['kind']
  targetId: string
  /** The API scopes the request matched, or its MCP tool. */
  scopes: string[]
  /**
   * The scopes union every action on the request's path, so one of them
   * cannot decide for the others (see `resolveApiPolicy`).
   */
  ambiguous?: boolean
}

const sameGrant = (a: SessionGrant, b: SessionGrant) =>
  a.kind === b.kind && a.targetId === b.targetId && a.scope === b.scope

/** Grant the session what this request matched. A request that matched nothing grants nothing. */
export async function addSessionGrants(agentSlug: string, sessionId: string, request: SessionGrantRequest): Promise<void> {
  const added: SessionGrant[] = [...new Set(request.scopes)]
    .map((scope) => ({ kind: request.kind, targetId: request.targetId, scope }))
  if (added.length === 0) return
  await reduceRecord(sessionGrantsKey(agentSlug, sessionId), (current) => {
    const kept = (current?.grants ?? []).filter((grant) => !added.some((one) => sameGrant(one, grant)))
    return { result: undefined, value: { grants: [...kept, ...added].slice(-MAX_SESSION_GRANTS) } }
  })
}

/**
 * Whether the session's grants cover this request: one granted scope is
 * enough, as one allowed scope is for the policy, unless the request's
 * endpoint is ambiguous, where every scope must be granted.
 */
export async function sessionGrantsCover(agentSlug: string, sessionId: string, request: SessionGrantRequest): Promise<boolean> {
  if (request.scopes.length === 0) return false
  const record = await appState().get(sessionGrantsKey(agentSlug, sessionId))
  if (!record) return false
  const granted = (scope: string) => record.value.grants.some((grant) =>
    sameGrant(grant, { kind: request.kind, targetId: request.targetId, scope }))
  return request.ambiguous ? request.scopes.every(granted) : request.scopes.some(granted)
}

/** The session is gone: so are its grants. */
export async function dropSessionGrants(agentSlug: string, sessionId: string): Promise<void> {
  await appState().delete(sessionGrantsKey(agentSlug, sessionId))
}
