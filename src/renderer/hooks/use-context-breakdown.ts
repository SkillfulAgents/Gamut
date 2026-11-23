import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { sessionContextSchema } from '@shared/lib/container/context-breakdown-schema'

export function useContextBreakdown(sessionId: string, agentSlug: string, enabled: boolean) {
  const refreshRequested = useRef(false)
  const queryKey = ['context-breakdown', agentSlug, sessionId]
  const read = async (refresh: boolean) => {
    const path = `/api/agents/${encodeURIComponent(agentSlug)}/sessions/${encodeURIComponent(sessionId)}/context`
    const res = await apiFetch(refresh ? path + '?refresh=true' : path)
    if (!res.ok) throw new Error('Failed to read context')
    return sessionContextSchema.parse(await res.json())
  }

  const query = useQuery({
    queryKey,
    // Share an in-flight count across panel remounts.
    queryFn: () => {
      const refresh = refreshRequested.current
      refreshRequested.current = false
      return read(refresh)
    },
    enabled,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  })
  const refresh = async () => {
    refreshRequested.current = true
    try {
      await query.refetch({ cancelRefetch: false })
    } finally {
      refreshRequested.current = false
    }
  }
  return { ...query, refresh }
}
