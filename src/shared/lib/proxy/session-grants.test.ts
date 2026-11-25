/**
 * "Allow for this session": the grant store, and the agent's reviews that
 * make grants from a card and answer whether a session's request is covered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'
import { attachLiveSessionsHarness } from '@shared/lib/agent-actor/testing/live-sessions-harness'
import type { ReviewRequest } from './agent-reviews'
import { MAX_SESSION_GRANTS } from './session-grants-schema'
import {
  addSessionGrants,
  dropSessionGrants,
  SESSION_GRANT_TTL_MS,
  sessionGrantsCover,
  sessionGrantsKey,
} from './session-grants'

const AGENT = 'session-grants-agent'
const SESSION = 'session-grants-session'
const OTHER_SESSION = 'session-grants-other-session'

describe('session grants store', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const api = (scopes: string[], ambiguous = false) => ({ kind: 'api' as const, targetId: 'acct-1', scopes, ambiguous })

  it('covers a request that shares one granted scope', async () => {
    await addSessionGrants(AGENT, SESSION, api(['gmail.send']))
    expect(await sessionGrantsCover(AGENT, SESSION, api(['gmail.send', 'gmail.full']))).toBe(true)
    expect(await sessionGrantsCover(AGENT, SESSION, api(['gmail.readonly']))).toBe(false)
  })

  it('needs every scope of an ambiguous request', async () => {
    await addSessionGrants(AGENT, SESSION, api(['read']))
    expect(await sessionGrantsCover(AGENT, SESSION, api(['read', 'delete'], true))).toBe(false)
    await addSessionGrants(AGENT, SESSION, api(['delete']))
    expect(await sessionGrantsCover(AGENT, SESSION, api(['read', 'delete'], true))).toBe(true)
  })

  it('never covers a request that matched nothing', async () => {
    await addSessionGrants(AGENT, SESSION, api(['gmail.send']))
    expect(await sessionGrantsCover(AGENT, SESSION, api([]))).toBe(false)
    expect(await sessionGrantsCover(AGENT, SESSION, api([], true))).toBe(false)
  })

  it('keeps a grant to its session, agent, account and kind', async () => {
    await addSessionGrants(AGENT, SESSION, api(['send']))
    expect(await sessionGrantsCover(AGENT, OTHER_SESSION, api(['send']))).toBe(false)
    expect(await sessionGrantsCover('another-agent', SESSION, api(['send']))).toBe(false)
    expect(await sessionGrantsCover(AGENT, SESSION, { ...api(['send']), targetId: 'acct-2' })).toBe(false)
    expect(await sessionGrantsCover(AGENT, SESSION, { ...api(['send']), kind: 'mcp' })).toBe(false)
  })

  it('writes nothing for a request that matched nothing', async () => {
    await addSessionGrants(AGENT, SESSION, api([]))
    expect(await appState().get(sessionGrantsKey(AGENT, SESSION))).toBeNull()
  })

  it('stores a repeated grant once and drops the oldest past the cap', async () => {
    await addSessionGrants(AGENT, SESSION, api(['first', 'first']))
    await addSessionGrants(AGENT, SESSION, api(['first']))
    expect((await appState().get(sessionGrantsKey(AGENT, SESSION)))?.value.grants).toHaveLength(1)

    await addSessionGrants(AGENT, SESSION, api(Array.from({ length: MAX_SESSION_GRANTS }, (_, i) => `scope-${i}`)))
    expect((await appState().get(sessionGrantsKey(AGENT, SESSION)))?.value.grants).toHaveLength(MAX_SESSION_GRANTS)
    expect(await sessionGrantsCover(AGENT, SESSION, api(['first']))).toBe(false)
    expect(await sessionGrantsCover(AGENT, SESSION, api(['scope-0']))).toBe(true)
  })

  it('expires 24 hours after the latest grant', async () => {
    await addSessionGrants(AGENT, SESSION, api(['one']))
    vi.advanceTimersByTime(SESSION_GRANT_TTL_MS - 1000)
    await addSessionGrants(AGENT, SESSION, api(['two']))
    vi.advanceTimersByTime(SESSION_GRANT_TTL_MS - 1000)
    expect(await sessionGrantsCover(AGENT, SESSION, api(['one']))).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(await sessionGrantsCover(AGENT, SESSION, api(['one']))).toBe(false)
  })

  it('drops a session\'s grants', async () => {
    await addSessionGrants(AGENT, SESSION, api(['one']))
    await dropSessionGrants(AGENT, SESSION)
    expect(await sessionGrantsCover(AGENT, SESSION, api(['one']))).toBe(false)
  })
})

describe('allow for this session', () => {
  const live = attachLiveSessionsHarness()
  const reviews = () => live.agents.get(AGENT).reviews
  const sessions = () => live.sessions(AGENT)

  function details(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
    return {
      accountId: 'acct-1',
      reviewType: 'api',
      toolkit: 'gmail',
      method: 'POST',
      targetPath: 'gmail/v1/users/me/messages/send',
      matchedScopes: ['gmail.send'],
      scopeDescriptions: { 'gmail.send': 'Send email' },
      callerSessionId: SESSION,
      ...overrides,
    }
  }
  const check = (overrides: Partial<Parameters<ReturnType<typeof reviews>['sessionAllows']>[0]> = {}) =>
    reviews().sessionAllows({ callerSessionId: SESSION, kind: 'api', targetId: 'acct-1', scopes: ['gmail.send'], ...overrides })

  beforeEach(() => {
    vi.useFakeTimers()
    sessions().markActive(SESSION)
    sessions().markActive(OTHER_SESSION)
  })

  afterEach(() => {
    live.reset()
    vi.useRealTimers()
  })

  it('allows the review and covers the session\'s later requests like it', async () => {
    const parked = reviews().request(details(), { id: 'r1' })
    expect(await check()).toBe(false)

    expect(await reviews().allowForSession('r1')).toBe('granted')
    expect(await parked).toBe('allow')
    expect(await check()).toBe(true)
    expect(await check({ scopes: ['gmail.readonly'] })).toBe(false)
    expect(await check({ callerSessionId: OTHER_SESSION })).toBe(false)
    expect(await check({ callerSessionId: undefined })).toBe(false)
  })

  it('counts only while the session is at work', async () => {
    const parked = reviews().request(details(), { id: 'r1' })
    await reviews().allowForSession('r1')
    await parked

    sessions().markIdle(SESSION)
    expect(await check()).toBe(false)
    sessions().markActive(SESSION)
    expect(await check()).toBe(true)
  })

  it('releases the session\'s other reviews it covers, and no one else\'s', async () => {
    const first = reviews().request(details(), { id: 'r1' })
    const sibling = reviews().request(details({ targetPath: 'gmail/v1/users/me/drafts/send' }), { id: 'r2' })
    const otherScope = reviews().request(details({ matchedScopes: ['gmail.readonly'] }), { id: 'r3' })
    const otherAccount = reviews().request(details({ accountId: 'acct-2' }), { id: 'r4' })
    const otherSession = reviews().request(details({ callerSessionId: OTHER_SESSION }), { id: 'r5' })

    expect(await reviews().allowForSession('r1')).toBe('granted')
    expect(await first).toBe('allow')
    expect(await sibling).toBe('allow')
    expect(reviews().pending().map((review) => review.id).sort()).toEqual(['r3', 'r4', 'r5'])

    reviews().denyAll()
    await Promise.all([otherScope, otherAccount, otherSession])
  })

  it('hands a covered sibling back to its caller to decide again when it asked to recheck', async () => {
    const first = reviews().request(details(), { id: 'r1' })
    const sibling = reviews().request(details(), { id: 'r2', recheck: true })
    await reviews().allowForSession('r1')
    await first
    expect(await sibling).toBe('recheck')
    expect(await reviews().settle('r2', 'allow')).toBe('allow')
  })

  it('grants an MCP review its tool', async () => {
    const parked = reviews().request(details({
      accountId: 'mcp-1', reviewType: 'mcp', toolkit: 'linear', method: 'tools/call',
      targetPath: 'tools/call/create_issue', matchedScopes: ['create_issue'], scopeDescriptions: {},
    }), { id: 'r1' })
    expect(await reviews().allowForSession('r1')).toBe('granted')
    await parked
    expect(await check({ kind: 'mcp', targetId: 'mcp-1', scopes: ['create_issue'] })).toBe(true)
    expect(await check({ kind: 'mcp', targetId: 'mcp-1', scopes: ['delete_issue'] })).toBe(false)
    expect(await check({ kind: 'api', targetId: 'mcp-1', scopes: ['create_issue'] })).toBe(false)
  })

  it.each([
    ['a card shown to the whole agent', { callerSessionId: undefined }],
    ['a request that matched no scope', { matchedScopes: [] }],
    ['a request a require rule held', {
      ruleOutcomes: [{ ruleId: 'rule-1', version: 1, effect: 'require' as const, name: 'Hold sends', restatement: 'Sends need review', result: 'matched' }],
    }],
  ])('is not offered on %s', async (_name, overrides) => {
    const parked = reviews().request(details(overrides), { id: 'r1' })
    expect(await reviews().allowForSession('r1')).toBe('not_offered')
    expect(reviews().pending()).toHaveLength(1)
    expect(await appState().get(sessionGrantsKey(AGENT, SESSION))).toBeNull()
    reviews().submit('r1', 'deny')
    await parked
  })

  it('is not offered on an x-agent review', async () => {
    const parked = reviews().requestXAgent({ targetAgentSlug: 'bob', targetAgentName: 'Bob', operation: 'read', callerSessionId: SESSION }, { id: 'r1' })
    expect(await reviews().allowForSession('r1')).toBe('not_offered')
    reviews().submit('r1', 'deny')
    await parked
  })

  it('does not find a review that is gone', async () => {
    expect(await reviews().allowForSession('missing')).toBe('not_found')
  })
})
