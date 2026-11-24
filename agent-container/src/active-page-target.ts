export interface PageTargetCandidate {
  id: string;
  url: string;
}

export interface BrowserTabCandidate {
  url: string;
  active: boolean;
  /** CDP target id, when the daemon reports it (agent-browser 0.34+). */
  targetId?: string;
}

export interface ActivePageTargetSelectionOptions {
  /** The CDP target currently rendered in the browser viewer. */
  viewerTargetId?: string | null;
  /** Use the viewer before daemon/MRU resolution for user-directed actions. */
  preferViewer?: boolean;
}

/**
 * Resolve a session's page among Chrome's: the tab its agent-browser instance
 * (`daemonTabs`) is on, optionally giving a user-selected viewer page priority
 * for operations that act on exactly what the user is looking at.
 *
 * Never any other page: the browser is shared by the agent's sessions, so a
 * page the instance is not on may be another session's. With no match (the
 * session's tab was closed, its instance did not answer) there is none.
 *
 * Viewer priority must stay opt-in: auto-follow callers are trying to discover
 * where the viewer should move and would become sticky if its current target
 * were used as their fallback.
 */
export function selectActivePageTarget<T extends PageTargetCandidate>(
  targets: T[],
  daemonTabs: BrowserTabCandidate[],
  urlsMatch: (left: string, right: string) => boolean,
  options: ActivePageTargetSelectionOptions = {},
): T | null {
  if (targets.length === 0) return null;

  if (options.preferViewer && options.viewerTargetId) {
    const viewerTarget = targets.find((target) => target.id === options.viewerTargetId);
    if (viewerTarget) return viewerTarget;
  }

  const activeDaemonTab = daemonTabs.find((tab) => tab.active);
  if (activeDaemonTab) {
    // The target id names the tab exactly; the URL is ambiguous when two tabs
    // share one and stale when the daemon has not seen a navigation.
    const byId = activeDaemonTab.targetId
      ? targets.find((target) => target.id === activeDaemonTab.targetId)
      : undefined;
    if (byId) return byId;
    const daemonTarget = targets.find((target) => urlsMatch(target.url, activeDaemonTab.url));
    if (daemonTarget) return daemonTarget;
  }

  return null;
}
