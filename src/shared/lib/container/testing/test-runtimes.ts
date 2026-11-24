/**
 * Test helper: agents' container runtimes without their actors.
 *
 * In the app each agent's actor asks the container host for its runtime and
 * holds it. A container-layer test without actors holds these instead: one
 * runtime per slug, made on first use, as an actor makes it. By default an agent has no live sessions, an idle
 * alarm that never arms and a watch that checks nothing; `use` changes what
 * the runtimes made after it get.
 *
 *   const agents = attachTestRuntimes(containerHost)
 *   await agents.runtime('a').ensureRunning()
 *   agents.reset()  // between tests
 */
import { ContainerWatch } from '../container-watch'
import type { ContainerHost } from '../container-host'
import type { ContainerRuntime, RuntimeAgent } from '../container-runtime'
import type { RuntimeSessions } from '../agent-sessions-access'

/** The sessions of an agent that has none live. */
export const NO_LIVE_SESSIONS: RuntimeSessions = {
  claimMidTurnForRecovery: () => [],
  settleRecovering: () => {},
  markRecovered: () => {},
  takeCoalesced: () => [],
  isRecovering: () => false,
  isSubscribed: () => false,
  subscribe: async () => {},
  inDeliveryTurn: (_sessionId, work) => work(),
  markAllStopped: () => {},
  markAllInactive: () => {},
  hasActive: () => false,
  hasAwaitingInput: () => false,
}

/** What a test gives an agent's runtime in place of its actor's parts; given a function, the runtime it is for. */
export type TestRuntimeParts = (slug: string, runtime: () => ContainerRuntime) => Partial<RuntimeAgent>

export interface TestRuntimes {
  /** The agent's runtime, made on first use. */
  runtime(slug: string): ContainerRuntime
  /** The agent's runtime, when one was made. */
  peek(slug: string): ContainerRuntime | undefined
  /** Dispose of the agent's runtime and forget it, as evicting its actor does. */
  drop(slug: string): void
  /** What runtimes made from now on get; returns what they got before. */
  use(parts: TestRuntimeParts): TestRuntimeParts
  /** Drop every runtime, and go back to the default parts. */
  reset(): void
}

export function attachTestRuntimes(host: ContainerHost): TestRuntimes {
  const runtimes = new Map<string, ContainerRuntime>()
  let parts: TestRuntimeParts = () => ({})
  const make = (slug: string): ContainerRuntime => {
    let runtime: ContainerRuntime | undefined
    const self = () => runtime!
    const given = parts(slug, self)
    const agent: RuntimeAgent = {
      sessions: NO_LIVE_SESSIONS,
      // No actor here, so nothing sleeps these containers.
      idleAlarm: { arm: () => {}, disarm: () => {} },
      containerWatch: new ContainerWatch({ checkHealth: async () => {}, checkStatus: async () => {} }),
      instructions: async () => null,
      clearComputerUseApp: () => {},
      forgetRuntime: () => drop(slug),
      ...given,
    }
    runtime = host.createRuntime(slug, agent)
    return runtime
  }
  const runtime = (slug: string): ContainerRuntime => {
    let made = runtimes.get(slug)
    if (!made) {
      made = make(slug)
      runtimes.set(slug, made)
    }
    return made
  }
  const drop = (slug: string): void => {
    // Forgotten before it is disposed, as an agent's state does it.
    const dropped = runtimes.get(slug)
    runtimes.delete(slug)
    dropped?.dispose()
  }
  return {
    runtime,
    peek: (slug) => runtimes.get(slug),
    drop,
    use: (next) => {
      const previous = parts
      parts = next
      return previous
    },
    reset: () => {
      for (const slug of [...runtimes.keys()]) drop(slug)
      parts = () => ({})
    },
  }
}
