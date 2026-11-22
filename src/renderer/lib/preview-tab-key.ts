import type { PreviewTab } from '@renderer/context/file-preview-context'

/**
 * Identity of an open tab.
 *
 * The agent slug is part of it because a path on its own is not unique: two
 * agents can each have a `/workspace/report.md`, and a drawer that outlives one
 * agent — the chat-integration views, the dashboard — would otherwise treat the
 * two files as one tab, showing the first agent's bytes under the second's
 * name.
 */
export function getPreviewTabKey(tab: PreviewTab): string {
  const path = tab.kind === 'file' ? tab.filePath : tab.rootPath
  return `${tab.kind}:${getWorkspaceFileKey(tab.agentSlug, path)}`
}

/**
 * Identity of one agent's copy of a path.
 *
 * Everything the drawer keys by a file keys by this: the tab, and the comments
 * hanging off it. Keying only half the drawer by the agent would be worse than
 * keying none of it — the tabs would separate while the state behind them still
 * aliased, so feedback left on one agent's report would appear on, and be
 * submitted with, another's.
 */
export function getWorkspaceFileKey(agentSlug: string, filePath: string): string {
  return `${agentSlug}:${filePath}`
}
