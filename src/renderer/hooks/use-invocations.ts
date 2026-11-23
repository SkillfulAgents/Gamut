import { useQuery } from '@tanstack/react-query'
import { apiJson } from '@renderer/lib/api'
import { invokedSessionSchema } from '@shared/lib/services/x-agent/invoked-session-schema'

export function useInvocationList(agentSlug: string, sessionId: string, history: boolean, enabled = true) {
  return useQuery({
    queryKey: ['invoked-sessions', agentSlug, sessionId, history],
    queryFn: async ({ signal }) => invokedSessionSchema.array().parse(await apiJson(
      `/api/agents/${agentSlug}/sessions/${sessionId}/invocations?history=${history}`, { signal },
    )),
    enabled,
    refetchInterval: history ? false : 4000,
  })
}
