/**
 * Test helpers: an agent's own stores, with some of their methods replaced.
 *
 * An actor's review and re-auth ops read the agent's stores: its reviews
 * (`AgentReviews`) and its re-auth waits. A route test that needs those to
 * answer a certain way mocks the store's module with these, naming the
 * store's own methods:
 *
 *   vi.mock('@shared/lib/proxy/agent-reviews', async (importOriginal) => {
 *     const { agentReviewsWith } = await import('@shared/lib/agent-actor/testing/agent-store-mocks')
 *     return agentReviewsWith(await importOriginal<typeof import('@shared/lib/proxy/agent-reviews')>(), (agentSlug) => ({
 *       request: (details, options) => mockRequestReview({ ...details, agentSlug }, options),
 *       settle: (id, decision) => mockSettleReview(agentSlug, id, decision),
 *     }))
 *   })
 *
 * Every method not named is the real store's. The replacements are asked for
 * once per agent, as its store is made, with the agent's slug and the store
 * as it really is, so a replacement can hand a call on to the real method.
 */

/** Methods of `Store` to replace: each one takes the place of the store's own. */
type Replaced<Store> = { [K in keyof Store]?: Store[K] extends (...args: infer A) => unknown ? (...args: A) => unknown : never }

/** `store`'s own methods, bound: what a replacement calls to reach the real thing. */
function realOf<Store extends object>(store: Store): Store {
  const real = Object.create(null) as Record<string, unknown>
  for (let proto: object | null = store; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const member = (store as Record<string, unknown>)[name]
      if (name !== 'constructor' && !(name in real) && typeof member === 'function') real[name] = (member as (...args: unknown[]) => unknown).bind(store)
    }
  }
  return real as Store
}

function replaceMethods<Store extends object>(store: Store, replaced: Replaced<Store>): Store {
  for (const [name, method] of Object.entries(replaced)) {
    if (method) (store as Record<string, unknown>)[name] = method
  }
  return store
}

/** The `agent-reviews` module, whose `AgentReviews` has the methods `replace` names, for each agent. */
export function agentReviewsWith<M extends { AgentReviews: new (...args: never[]) => object }>(
  actual: M,
  replace: (agentSlug: string, real: InstanceType<M['AgentReviews']>) => Replaced<InstanceType<M['AgentReviews']>>,
): M {
  const Real = actual.AgentReviews as unknown as new (...args: unknown[]) => object
  class AgentReviewsWithReplacements extends Real {
    constructor(...args: unknown[]) {
      super(...args)
      const store = this as unknown as InstanceType<M['AgentReviews']>
      replaceMethods(store, replace(args[0] as string, realOf(store)))
    }
  }
  return { ...actual, AgentReviews: AgentReviewsWithReplacements }
}

/**
 * The `reauth-waits` module, whose account and MCP waits have the methods
 * `replace` names, for each agent. Either kind may be left out.
 */
export function reauthWaitsWith<
  M extends { createAccountReauthWaits: (...args: never[]) => object; createMcpReauthWaits: (...args: never[]) => object },
>(
  actual: M,
  replace: {
    account?: (agentSlug: string, real: ReturnType<M['createAccountReauthWaits']>) => Replaced<ReturnType<M['createAccountReauthWaits']>>
    mcp?: (agentSlug: string, real: ReturnType<M['createMcpReauthWaits']>) => Replaced<ReturnType<M['createMcpReauthWaits']>>
  },
): M {
  const account = actual.createAccountReauthWaits as unknown as (...args: unknown[]) => ReturnType<M['createAccountReauthWaits']>
  const mcp = actual.createMcpReauthWaits as unknown as (...args: unknown[]) => ReturnType<M['createMcpReauthWaits']>
  return {
    ...actual,
    createAccountReauthWaits: (...args: unknown[]) => {
      const waits = account(...args)
      return replace.account ? replaceMethods(waits, replace.account(args[0] as string, realOf(waits))) : waits
    },
    createMcpReauthWaits: (...args: unknown[]) => {
      const waits = mcp(...args)
      return replace.mcp ? replaceMethods(waits, replace.mcp(args[0] as string, realOf(waits))) : waits
    },
  }
}
