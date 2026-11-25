import { apiFetch } from '@renderer/lib/api'
import { useStreamBackedPollMs } from '@renderer/lib/notification-stream-health'
import { useQuery } from '@tanstack/react-query'

export interface ArtifactInfo {
  slug: string
  name: string
  description: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  port: number
  startupPhase?: 'installing-dependencies' | 'starting-server'
  firstRun?: boolean
}

/**
 * Default cadence, or 300ms when the viewed dashboard is actively waiting —
 * a dashboard becomes serveable in well under a second once its port is up,
 * so a 1s poll was a large share of the perceived wait. The fast interval
 * only applies while a DashboardView is mounted and unresolved (pollFast).
 *
 * `watching` is the 1s floor for that same mounted-and-unresolved window:
 * pollFast deliberately turns off after the slow bound, and a queued
 * dashboard still reports 'stopped' — without the floor, exactly the
 * slowest starts fell back to the 60s idle cadence and sat invisible for
 * up to a minute after coming up.
 */
export const ARTIFACTS_IDLE_POLL_MS = 60_000

export function artifactsRefetchIntervalMs(
  data: ArtifactInfo[] | undefined,
  pollFast: boolean,
  watching: boolean = false,
  idleMs: number = ARTIFACTS_IDLE_POLL_MS,
): number {
  if (pollFast) return 300
  const hasStarting = data?.some((a) => a.status === 'starting')
  return watching || hasStarting ? 1_000 : idleMs
}

/**
 * `namesOnly` is for a caller that shows which dashboards exist and what they
 * are called, not whether they run (the sidebar). Those change when the agent
 * finishes a turn, when it starts or stops, when a dashboard comes up or
 * crashes, or when this window renames or deletes one, and each of those
 * reads the list again at once. So while the notifications stream delivers,
 * the idle poll only catches what none of them announce (a rename or delete
 * made elsewhere, a file changed outside a turn) and runs every five minutes;
 * without the stream it keeps its 60 s. The cadences while a dashboard is
 * starting are the same for every caller.
 *
 * A caller that shows a dashboard's state must not pass it: a dashboard that
 * exits cleanly reports 'stopped' with no event, and only the poll finds it.
 */
export function useArtifacts(
  agentSlug: string | null,
  options?: { pollFast?: boolean; watching?: boolean; namesOnly?: boolean },
) {
  const pollFast = options?.pollFast ?? false
  const watching = options?.watching ?? false
  const streamBackedIdleMs = useStreamBackedPollMs(ARTIFACTS_IDLE_POLL_MS)
  const idleMs = options?.namesOnly ? streamBackedIdleMs : ARTIFACTS_IDLE_POLL_MS
  return useQuery<ArtifactInfo[]>({
    queryKey: ['artifacts', agentSlug],
    queryFn: async () => {
      const res = await apiFetch(`/api/agents/${agentSlug}/artifacts`)
      if (!res.ok) throw new Error('Failed to fetch artifacts')
      return res.json()
    },
    enabled: !!agentSlug,
    staleTime: 60_000,
    refetchInterval: (query) => artifactsRefetchIntervalMs(query.state.data, pollFast, watching, idleMs),
  })
}
