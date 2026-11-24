import { AgentStores, type AgentStoreDirectory } from './store-directory'
import type { McpReauthDetails, McpReauthWaits, ReauthOutcome } from '@shared/lib/proxy/reauth-waits'
import { awaitReauth } from '@shared/lib/proxy/reauth-request'

/**
 * The router in front of every agent's MCP re-auth waits, for tests: the
 * app reaches them through the agent's actor (`inputs.mcpReauth`). The waits live in
 * each agent's actor (`AgentReauthWaits`, see `reauth-waits`); this singleton
 * dispatches the calls that arrive with a slug.
 */
export class McpReauthManager {
  private readonly agents = new AgentStores<McpReauthWaits>('MCP re-auth waits', (state) => state.mcpReauth)

  /** Tests only: read the agents' waits from `directory` in place of the registry's actors. */
  attachAgents(directory: AgentStoreDirectory<McpReauthWaits> | null): void {
    this.agents.replaceWith(directory)
  }

  /** Park a request of the agent on its re-auth card and wait for how it ends (see `awaitReauth`). */
  requestReauth(details: McpReauthDetails, signal?: AbortSignal): Promise<ReauthOutcome> {
    const waits = this.agents.get(details.agentSlug)
    return awaitReauth(waits, details, signal)
  }

  /** `AgentReauthWaits.request` on the agent's waits: the outcome as data. */
  request(agentSlug: string, details: Omit<McpReauthDetails, 'agentSlug'>, options: { waitId: string }): Promise<ReauthOutcome> {
    return this.agents.get(agentSlug).request(details, options)
  }

  /** `AgentReauthWaits.withdraw` on the agent's waits. */
  withdraw(agentSlug: string, waitId: string): void {
    this.agents.peek(agentSlug)?.withdraw(waitId)
  }

  /** `AgentReauthWaits.dismiss` on the agent's waits; false when it holds no such card. */
  dismiss(entryId: string, agentSlug: string, reason?: string): boolean {
    return this.agents.peek(agentSlug)?.dismiss(entryId, reason) ?? false
  }

  /** Settle this agent's waiters without resuming them against stale tools. */
  replaceMcp(entryId: string, agentSlug: string, replacementMcpId: string): boolean {
    return this.agents.peek(agentSlug)?.replace(entryId, replacementMcpId) ?? false
  }

  /** Resume the agent's parked proxy requests that use the reconnected MCP. */
  completeMcp(agentSlug: string, mcpId: string): number {
    return this.agents.peek(agentSlug)?.complete(mcpId) ?? 0
  }
}

// One per evaluation of this module: it holds nothing (see `reviewManager`).
export const mcpReauthManager = new McpReauthManager()
