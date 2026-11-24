import type { XAgentFileTransfer, XAgentRuntime } from '@shared/lib/proxy/x-agent-review'
import { AgentStores, type AgentStoreDirectory } from './store-directory'
import type { AgentReviews, ReviewDecision, ReviewDecisionDetail, ReviewOutcome, ReviewRequest, ReviewRequestOptions, XAgentOperation } from '@shared/lib/proxy/agent-reviews'
import type { ReviewDetails } from '@shared/lib/proxy/review-display'
import { awaitReview, type ReviewReevaluator, type ReviewResult } from '@shared/lib/proxy/review-request'
import type { ScopeLabel } from '@shared/lib/proxy/scope-metadata'

/**
 * The router in front of every agent's reviews, for tests: the app raises and
 * decides a review through the agent's actor (`inputs.reviews`). The reviews
 * live in each agent's actor (`AgentReviews`); this singleton dispatches a
 * call that arrives with a slug to the store of that agent's actor, which it
 * finds in the registry.
 */
export class ReviewManager {
  private readonly agents = new AgentStores<AgentReviews>('reviews', (state) => state.reviews)

  /** Tests only: read the agents' reviews from `directory` in place of the registry's actors. */
  attachAgents(directory: AgentStoreDirectory<AgentReviews> | null): void {
    this.agents.replaceWith(directory)
  }

  /** Raise a review for the agent a call came from and wait for its decision (see `awaitReview`). */
  requestReview(details: ReviewRequest & { agentSlug: string }, signal?: AbortSignal, options?: { reevaluate?: ReviewReevaluator }): Promise<ReviewResult> {
    const reviews = this.agents.get(details.agentSlug)
    return awaitReview(reviews, (raise) => reviews.request(details, raise), { signal, ...options })
  }

  /** `AgentReviews.request` on the agent's reviews: the outcome as data. */
  request(agentSlug: string, details: ReviewRequest, options: ReviewRequestOptions): Promise<ReviewOutcome> {
    return this.agents.get(agentSlug).request(details, options)
  }

  withdraw(agentSlug: string, id: string): void {
    this.agents.peek(agentSlug)?.withdraw(id)
  }

  resume(agentSlug: string, id: string): Promise<ReviewOutcome> {
    return this.agents.peek(agentSlug)?.resume(id) ?? Promise.resolve('withdrawn')
  }

  settle(agentSlug: string, id: string, decision: ReviewDecision): Promise<ReviewOutcome> {
    return this.agents.peek(agentSlug)?.settle(id, decision) ?? Promise.resolve('withdrawn')
  }

  /**
   * Resolve one of the agent's pending reviews by id. Only the agent's store
   * is consulted: a user with a role on agent A who sends agent B's review id
   * to A's URL finds nothing — the same `false` as "review not found", so
   * nothing leaks to an unauthorized caller.
   */
  submitDecision(agentSlug: string, id: string, decision: ReviewDecision, detail?: ReviewDecisionDetail): boolean {
    return this.agents.peek(agentSlug)?.submit(id, decision, detail) ?? false
  }

  takeDecisionDetail(agentSlug: string, id: string): Promise<ReviewDecisionDetail> {
    return this.agents.peek(agentSlug)?.takeDecisionDetail(id) ?? Promise.resolve({})
  }

  resolveMatchingPending(agentSlug: string, scope: string, decision: ReviewDecision): void {
    this.agents.peek(agentSlug)?.resolveMatching(scope, decision)
  }

  resolveMatchingPendingByLabel(agentSlug: string, label: ScopeLabel, decision: ReviewDecision): void {
    this.agents.peek(agentSlug)?.resolveMatchingByLabel(label, decision)
  }

  resolveMatchingXAgentByOperation(agentSlug: string, operation: XAgentOperation, decision: ReviewDecision): void {
    this.agents.peek(agentSlug)?.resolveMatchingXAgent(operation, decision)
  }

  getPendingReviewsForAgent(agentSlug: string): Array<{ id: string; displayText: string } & ReviewDetails> {
    return this.agents.peek(agentSlug)?.pending() ?? []
  }

  /** Raise an x-agent review for the calling agent and wait for its decision (see `awaitReview`). */
  requestXAgentReview(
    callerAgentSlug: string,
    targetAgentSlug: string,
    targetAgentName: string,
    operation: XAgentOperation,
    preview?: string,
    fileTransfer?: XAgentFileTransfer,
    signal?: AbortSignal,
  ): Promise<ReviewResult> {
    const reviews = this.agents.get(callerAgentSlug)
    return awaitReview(reviews, (raise) => reviews.requestXAgent({ targetAgentSlug, targetAgentName, operation, preview, fileTransfer }, raise), { signal })
  }

  /** `AgentReviews.requestXAgent` on the calling agent's reviews: the outcome as data. */
  requestXAgent(
    callerAgentSlug: string,
    request: { targetAgentSlug: string; targetAgentName: string; operation: XAgentOperation; preview?: string; fileTransfer?: XAgentFileTransfer; runtime?: XAgentRuntime; callerSessionId?: string },
    options: ReviewRequestOptions,
  ): Promise<ReviewOutcome> {
    return this.agents.get(callerAgentSlug).requestXAgent(request, options)
  }

  denyAllForAgent(agentSlug: string, sessionId?: string): void {
    this.agents.peek(agentSlug)?.denyAll(sessionId)
  }

  rejectAll(): void {
    for (const reviews of this.agents.all()) reviews.rejectAll()
  }
}

// One per evaluation of this module: it holds nothing, and reads the registry
// of the same evaluation. The reviews themselves survive a dev-server reload
// with the agents' state.
export const reviewManager = new ReviewManager()
