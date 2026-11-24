import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useInvocationList } from './use-invocations'
import { useAgents } from '@renderer/hooks/use-agents'
import { sessionQuery } from '@renderer/hooks/query-options'
import { collectAgentCalls, currentTurnStart, findCalledAgent } from '@renderer/components/tray/agent-calls'
import { calledSessionState } from '@renderer/components/agents/called-agent-avatar'
import type { ActivityAgentCall } from '@renderer/components/messages/activity-card'
import type { ApiMessageOrBoundary, ApiSession } from '@shared/lib/types/api'

/**
 * The other agents the current turn asked to work, each working for as long as
 * its own session is: an invoke_agent call returns at once unless it waited
 * (sync), so the call alone does not say whether the agent is still at it.
 */
export function useTurnAgentCalls(messages: ApiMessageOrBoundary[] | undefined, agentSlug: string, sessionId: string, active: boolean): ActivityAgentCall[] {
  const { data: agents } = useAgents()
  const recent = useMemo(
    () => collectAgentCalls(messages, agentSlug, currentTurnStart(messages)),
    [messages, agentSlug],
  )
  const receipts = useInvocationList(agentSlug, sessionId, false, active && recent.length > 0)
  const start = messages?.[currentTurnStart(messages)]?.createdAt
  const calls = useMemo(() => {
    const found = [...recent]
    for (const receipt of receipts.data ?? []) {
      if (!start || Date.parse(receipt.calledAt) < new Date(start).getTime()) continue
      const matches = (call: (typeof recent)[number]) => {
        const slug = findCalledAgent(call.slug, agents)?.slug ?? call.slug
        return slug === receipt.agentSlug && call.sessionId === receipt.sessionId
      }
      if (found.some(matches)) continue
      // Pending sync calls have no id until they return. A recorded delivery already identifies their session.
      const candidates = recent.filter(call => !call.sessionId && (receipt.toolUseId
        ? call.toolUseId === receipt.toolUseId
        : (findCalledAgent(call.slug, agents)?.slug ?? call.slug) === receipt.agentSlug && call.prompt.slice(0, 300) === receipt.prompt))
      // Older receipts have no tool id. Only pair a unique pending call with a unique delivery.
      const uniqueReceipt = receipt.toolUseId || receipts.data?.filter(other => other.agentSlug === receipt.agentSlug &&
        other.prompt === receipt.prompt && Date.parse(other.calledAt) >= new Date(start).getTime()).length === 1
      const pending = candidates.length === 1 && uniqueReceipt ? found.indexOf(candidates[0]) : -1
      const entry = { key: JSON.stringify([receipt.agentSlug, receipt.sessionId]), toolUseId: receipt.toolUseId ?? '',
        slug: receipt.agentSlug, sessionId: receipt.sessionId, prompt: receipt.prompt, pending: false, reportedStatus: 'running' }
      if (pending >= 0) found[pending] = entry
      else found.push(entry)
    }
    return found
  }, [recent, receipts.data, start, agents])
  const sessions = useQueries({
    queries: calls.map((call) => ({
      ...sessionQuery(findCalledAgent(call.slug, agents)?.slug ?? call.slug, call.sessionId ?? ''),
      enabled: !!call.sessionId,
    })),
  })
  return calls.map((call, index) => {
    const session = sessions[index]?.data as ApiSession | undefined
    const agent = findCalledAgent(call.slug, agents)
    const state = calledSessionState(session, call.pending || call.reportedStatus === 'running')
    return {
      key: call.key,
      name: agent?.name ?? call.slug,
      // The slug rides on the agent so the row can open before the agent list has loaded.
      agent: agent ?? { slug: call.slug, avatar: undefined },
      prompt: call.prompt,
      state,
      sessionId: call.sessionId,
    }
  })
}
