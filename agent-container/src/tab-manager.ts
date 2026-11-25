/**
 * Tab Manager — centralized tab state, querying, detection, and message formatting.
 *
 * All tab-related logic lives here so server.ts and browser.ts can import shared helpers.
 */

import * as net from 'net';
import * as path from 'path';

const DEFAULT_MAX_TABS = 10;

export interface TabInfo {
  /** Stable tab id assigned by the agent-browser daemon (e.g. "t1") — does not shift when other tabs close */
  tabId: string;
  /**
   * The tab's CDP target id (agent-browser 0.34+). Matches Chrome's own
   * target list exactly — the URL does not when two tabs share one, or when
   * the daemon's copy of it is stale (host mode, Chrome's error page).
   */
  targetId?: string;
  /** Optional user-assigned label (tab new --label <name>) */
  label: string | null;
  url: string;
  title: string;
  active: boolean;
}

export interface NewTabResult {
  newTab: true;
  activeId: string;
  activeUrl: string;
  tabCount: number;
}

class TabManager {
  private maxTabs = DEFAULT_MAX_TABS;

  // --- State ---

  setMaxTabs(n: number): void {
    this.maxTabs = n;
  }

  getMaxTabs(): number {
    return this.maxTabs;
  }

  // --- Daemon Queries ---

  /** An agent-browser instance's Unix socket, by its `--session` name. */
  socketPath(session: string): string {
    const socketDir = process.env.AGENT_BROWSER_SOCKET_DIR
      || (process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'agent-browser') : null)
      || path.join(process.env.HOME || '/home/claude', '.agent-browser');
    return path.join(socketDir, `${session}.sock`);
  }

  /**
   * Ask a session's agent-browser instance (its `--session` name) for its tab
   * list via Unix socket. It lists every tab of the browser, and marks the
   * session's own as active. A read: it waits for no saved-session operation
   * (browser-gate.ts), which cannot move a pinned instance off its tab.
   */
  async queryTabs(session: string): Promise<TabInfo[]> {
    const tabs = (await this.daemonTabList(session)).data?.tabs;
    if (!tabs) throw new Error('No tabs');
    return tabs;
  }

  /** A `tab_list` over the instance's Unix socket. */
  private daemonTabList(session: string): Promise<{ data?: { tabs?: TabInfo[] } }> {
    const socketPath = this.socketPath(session);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { client.destroy(); reject(new Error('Timeout')); }, 3000);
      const client = net.createConnection(socketPath, () => {
        client.write(JSON.stringify({ id: 'tab-q', action: 'tab_list' }) + '\n');
      });
      let buf = '';
      client.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        try {
          const resp = JSON.parse(buf);
          clearTimeout(timeout);
          client.end();
          resp.success ? resolve(resp) : reject(new Error(resp.error || 'No tabs'));
        } catch { /* incomplete JSON, wait for more */ }
      });
      client.on('error', (err: Error) => { clearTimeout(timeout); reject(err); });
    });
  }

  // --- URL Matching ---

  /** Normalize and compare two URLs (origin + pathname + search, ignoring trailing slash and hash) */
  urlsMatch(a: string, b: string): boolean {
    try {
      const ua = new URL(a);
      const ub = new URL(b);
      return ua.origin === ub.origin &&
             ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '') &&
             ua.search === ub.search;
    } catch { return false; }
  }

  /** Find a usable tab whose URL matches the given URL — one at exactly that URL (fragment included) first. */
  async findMatchingTab(session: string, url: string, usable: (tab: TabInfo) => boolean = () => true): Promise<TabInfo | null> {
    try {
      const tabs = (await this.queryTabs(session)).filter(usable);
      return tabs.find(t => t.url === url) ?? tabs.find(t => this.urlsMatch(t.url, url)) ?? null;
    } catch { return null; }
  }

  // --- Message Formatting ---

  /** Format a notification about a newly opened tab (appended to click/press responses) */
  formatTabNotification(tabInfo: { activeId: string; activeUrl: string; tabCount: number }): string {
    const { activeId, activeUrl, tabCount } = tabInfo;
    let msg = `\nNew tab opened — you are now on tab ${activeId} (${activeUrl}). ${tabCount} tab(s) open.`;

    if (tabCount >= this.maxTabs) {
      msg += `\n⚠️ WARNING: ${tabCount} tabs open (max ${this.maxTabs}). You MUST close tabs you no longer need IMMEDIATELY: browser_run("tab") to list ids, then browser_run("tab close <id>") for each unneeded tab.`;
    } else {
      msg += `\nIf you no longer need the tab you came from, close it by id without switching: browser_run("tab close <id>") — browser_run("tab") lists ids like t1, t2.`;
    }

    return msg;
  }

  /** Escalating warning appended to tool responses when tabs are high */
  formatTabWarning(tabCount: number): string {
    if (tabCount >= this.maxTabs) return `\n\n🚨 CRITICAL: ${tabCount} TABS OPEN (limit: ${this.maxTabs}). STOP and close unneeded tabs NOW. Run browser_run("tab") to list ids, then browser_run("tab close <id>") for each extra.`;
    if (tabCount >= this.maxTabs - 1) return `\n\n[${tabCount} tabs open — close any you no longer need]`;
    return '';
  }

  /** Tab status line appended to snapshot/state responses */
  formatTabStatus(tabCount: number): string {
    if (tabCount <= 1) return '';
    if (tabCount >= this.maxTabs) return `\n\n[Tabs: ${tabCount} open — OVER LIMIT, close tabs NOW]`;
    return `\n\n[Tabs: ${tabCount} open]`;
  }
}

export const tabManager = new TabManager();
