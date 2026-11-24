import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiJson } from '@renderer/lib/api'
import { invokedSessionSchema } from '@shared/lib/services/x-agent/invoked-session-schema'

// Only a viewer of the calling session should open its tray. A later mount
// reads the same receipts, but an old receipt doesn't request navigation.
const liveInvocations = new EventTarget()

export function onAgentInvoked(sessionId: string, listener: () => void) {
  liveInvocations.addEventListener(sessionId, listener)
  return () => liveInvocations.removeEventListener(sessionId, listener)
}

export function receiveAgentInvocation(client: QueryClient, sessionId: string) {
  void client.invalidateQueries({ queryKey: ['invoked-sessions', sessionId] })
  liveInvocations.dispatchEvent(new Event(sessionId))
}

export function useInvocationList(agentSlug: string, sessionId: string, history: boolean, enabled = true) {
  return useQuery({
    queryKey: ['invoked-sessions', sessionId, agentSlug, history],
    queryFn: async ({ signal }) => invokedSessionSchema.array().parse(await apiJson(
      `/api/agents/${agentSlug}/sessions/${sessionId}/invocations?history=${history}`, { signal },
    )),
    enabled,
    refetchInterval: history ? false : 4000,
  })
}
