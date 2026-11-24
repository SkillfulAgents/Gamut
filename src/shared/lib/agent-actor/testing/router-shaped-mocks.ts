/**
 * Test helper: answer an actor's review and re-auth ops from a router-shaped mock.
 *
 * Route tests replace `reviewManager` (and the two re-auth managers) with an
 * object whose methods take the agent's slug, and assert on it. The actor's
 * ops read the agent's own stores, not those routers, so this presents the
 * same mock as the agent's store: a store method the mock spells (under the
 * router's name for it) is answered by the mock with the slug put back, and
 * every other one is the real store's. The mock is read at each call, so a
 * test may add a method to it later.
 *
 * Usage, after the test's own `vi.mock` of the router module:
 *
 *   vi.mock('@shared/lib/proxy/agent-reviews', async (importOriginal) => {
 *     const { reviewsAnsweredByRouterMock } = await import('@shared/lib/agent-actor/testing/router-shaped-mocks')
 *     const { reviewManager } = await import('@shared/lib/proxy/review-manager')
 *     return reviewsAnsweredByRouterMock(await importOriginal(), reviewManager)
 *   })
 */
type AnyFn = (...args: unknown[]) => unknown
type RouterShapedMock = Record<string, unknown>
/** How a router called its method with the slug, given the store's arguments. */
type Call = (fn: AnyFn, router: RouterShapedMock, slug: string, args: unknown[]) => unknown

const slugFirst: Call = (fn, router, slug, args) => fn.call(router, slug, ...args)
/** The re-auth managers name the card before the agent. */
const slugSecond: Call = (fn, router, slug, [first, ...rest]) => fn.call(router, first, slug, ...rest)

/** The store's method, the router's name for it, and where the router took the slug. */
const REVIEWS: Record<string, [string, Call]> = {
  request: ['request', slugFirst],
  requestXAgent: ['requestXAgent', slugFirst],
  withdraw: ['withdraw', slugFirst],
  resume: ['resume', slugFirst],
  settle: ['settle', slugFirst],
  takeDecisionDetail: ['takeDecisionDetail', slugFirst],
  pending: ['getPendingReviewsForAgent', slugFirst],
  submit: ['submitDecision', slugFirst],
  resolveMatching: ['resolveMatchingPending', slugFirst],
  resolveMatchingByLabel: ['resolveMatchingPendingByLabel', slugFirst],
  resolveMatchingXAgent: ['resolveMatchingXAgentByOperation', slugFirst],
  denyAll: ['denyAllForAgent', slugFirst],
}

const reauth = (replace: string, complete: string): Record<string, [string, Call]> => ({
  request: ['request', slugFirst],
  withdraw: ['withdraw', slugFirst],
  dismiss: ['dismiss', slugSecond],
  replace: [replace, slugSecond],
  complete: [complete, slugFirst],
})
const ACCOUNT_REAUTH = reauth('replaceAccount', 'completeAccount')
const MCP_REAUTH = reauth('replaceMcp', 'completeMcp')

/**
 * `store`, with each mapped method answered by `router` when the router
 * spells it. A mock that hands a call on to a real router ends at the real
 * store: a call that comes back while the mock is answering is the store's own.
 */
function answeredBy<T extends object>(store: T, slug: string, router: RouterShapedMock, methods: Record<string, [string, Call]>): T {
  const target = store as Record<string, unknown>
  let answering = false
  for (const [storeName, [routerName, call]] of Object.entries(methods)) {
    const real = target[storeName] as AnyFn | undefined
    target[storeName] = (...args: unknown[]) => {
      const fn = router[routerName]
      if (answering || typeof fn !== 'function') return real?.apply(store, args)
      answering = true
      try {
        return call(fn as AnyFn, router, slug, args)
      } finally {
        answering = false
      }
    }
  }
  return store
}

/** The `agent-reviews` module, whose `AgentReviews` answers from a router-shaped `reviewManager` mock. */
export function reviewsAnsweredByRouterMock<M extends { AgentReviews: new (...args: never[]) => object }>(actual: M, router: unknown): M {
  const Real = actual.AgentReviews as unknown as new (...args: unknown[]) => object
  class AnsweredReviews extends Real {
    constructor(...args: unknown[]) {
      super(...args)
      answeredBy(this, args[0] as string, router as RouterShapedMock, REVIEWS)
    }
  }
  return { ...actual, AgentReviews: AnsweredReviews }
}

/**
 * The `reauth-waits` module, whose waits answer from router-shaped
 * `accountReauthManager` and `mcpReauthManager` mocks (either may be left out).
 */
export function reauthWaitsAnsweredByRouterMocks<
  M extends { createAccountReauthWaits: (...args: never[]) => object; createMcpReauthWaits: (...args: never[]) => object },
>(actual: M, routers: { account?: unknown; mcp?: unknown }): M {
  const account = actual.createAccountReauthWaits as unknown as (...args: unknown[]) => object
  const mcp = actual.createMcpReauthWaits as unknown as (...args: unknown[]) => object
  return {
    ...actual,
    createAccountReauthWaits: (...args: unknown[]) =>
      routers.account ? answeredBy(account(...args), args[0] as string, routers.account as RouterShapedMock, ACCOUNT_REAUTH) : account(...args),
    createMcpReauthWaits: (...args: unknown[]) =>
      routers.mcp ? answeredBy(mcp(...args), args[0] as string, routers.mcp as RouterShapedMock, MCP_REAUTH) : mcp(...args),
  }
}
