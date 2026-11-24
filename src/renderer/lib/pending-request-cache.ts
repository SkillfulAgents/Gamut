import type { QueryClient } from '@tanstack/react-query'

/** A request opened or settled, or a stream reconnected after missing those events. */
export async function invalidatePendingUserRequests(client: QueryClient) {
  const queryKey = ['pending-user-requests']
  // invalidateQueries replaces an in-flight refresh, but joins the first read while data
  // is undefined. That read may already have captured the snapshot from before the event.
  await client.cancelQueries({
    queryKey,
    fetchStatus: 'fetching',
    predicate: query => query.state.data === undefined,
  })
  await client.invalidateQueries({ queryKey })
}
