import { AgentStores, type AgentStoreDirectory } from '@shared/lib/agent-actor/store-directory'
import type { AccountReauthDetails, AccountReauthWaits, ReauthOutcome } from './reauth-waits'
import { awaitReauth } from './reauth-request'

export {
  ACCOUNT_REAUTH_TIMEOUT_MS,
  createAccountReauthWaits,
  type AccountReauthDetails,
  type AccountReauthRequest,
  type AccountReauthWaits,
} from './reauth-waits'

/**
 * The router in front of every agent's account re-auth waits, for tests: the
 * app reaches them through the agent's actor (`inputs.accountReauth`). The
 * waits live in each agent's actor (`AgentReauthWaits`, see `reauth-waits`);
 * this singleton dispatches the calls that arrive with a slug.
 */
export class AccountReauthManager {
  private readonly agents = new AgentStores<AccountReauthWaits>('account re-auth waits', (state) => state.accountReauth)

  /** Tests only: read the agents' waits from `directory` in place of the registry's actors. */
  attachAgents(directory: AgentStoreDirectory<AccountReauthWaits> | null): void {
    this.agents.replaceWith(directory)
  }

  /** Park a request of the agent on its re-auth card and wait for how it ends (see `awaitReauth`). */
  requestReauth(details: AccountReauthDetails, signal?: AbortSignal): Promise<ReauthOutcome> {
    const waits = this.agents.get(details.agentSlug)
    return awaitReauth(waits, details, signal)
  }

  /** `AgentReauthWaits.request` on the agent's waits: the outcome as data. */
  request(agentSlug: string, details: Omit<AccountReauthDetails, 'agentSlug'>, options: { waitId: string }): Promise<ReauthOutcome> {
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

  /** Release only this agent's calls; other agents still use the old account. */
  replaceAccount(entryId: string, agentSlug: string, replacementAccountId: string): boolean {
    return this.agents.peek(agentSlug)?.replace(entryId, replacementAccountId) ?? false
  }

  /** Resume the agent's parked proxy requests that use the reconnected account. */
  completeAccount(agentSlug: string, accountId: string): number {
    return this.agents.peek(agentSlug)?.complete(accountId) ?? 0
  }
}

// One per evaluation of this module: it holds nothing (see `reviewManager`).
export const accountReauthManager = new AccountReauthManager()
