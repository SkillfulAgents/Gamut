/**
 * What a Browserbase session's status says about it, for the two providers
 * that run on Browserbase. RUNNING is the only one a browser can be reached
 * in; COMPLETED, ERROR and TIMED_OUT are final. Anything else leaves it
 * unknown whether the session still runs.
 */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'ERROR', 'TIMED_OUT'])

export function browserbaseSessionState(status: string): 'running' | 'ended' | 'unknown' {
  if (status === 'RUNNING') return 'running'
  return ENDED_STATUSES.has(status) ? 'ended' : 'unknown'
}
