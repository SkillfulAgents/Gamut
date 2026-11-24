/**
 * Ownership-tracked tab-list polling for the browser stream, which allows one
 * viewer at a time per browser session (`viewer`).
 *
 * Connections can overlap during a reconnect: the new socket attaches before
 * the old one's close event fires. A bare interval slot breaks both ways in
 * that window — assigning on connect leaks the previous timer (it polls
 * forever), and clearing the slot on the OLD socket's late close kills the
 * NEW viewer's polling. Each connection therefore keeps its own handle;
 * the viewer's slot only tracks which handle is current.
 */

const currentPolls = new Map<string, NodeJS.Timeout>();
const viewers = new Map<NodeJS.Timeout, string>();

/** Start polling for a new viewer connection, replacing any previous connection's timer for that viewer. */
export function startTabPolling(poll: () => void, intervalMs = 2000, viewer = ''): NodeJS.Timeout {
  const handle = setInterval(poll, intervalMs);
  const previous = currentPolls.get(viewer);
  if (previous) stopTabPolling(previous);
  currentPolls.set(viewer, handle);
  viewers.set(handle, viewer);
  return handle;
}

/**
 * Stop one connection's polling. Only vacates its viewer's slot if that
 * connection is still the current one. Safe to call twice (a socket can
 * fire both 'error' and 'close').
 */
export function stopTabPolling(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  const viewer = viewers.get(handle);
  viewers.delete(handle);
  if (viewer !== undefined && currentPolls.get(viewer) === handle) currentPolls.delete(viewer);
}
