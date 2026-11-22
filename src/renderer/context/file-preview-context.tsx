import { SessionTrayProvider, useRequiredTray, useTrayState } from './session-tray-context'
import { getPreviewTabKey, getWorkspaceFileKey } from '@renderer/lib/preview-tab-key'
export { getPreviewTabKey, getWorkspaceFileKey } from '@renderer/lib/preview-tab-key'
import { createContext, useContext, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { z } from 'zod'
import { getPathName, toWorkspaceAbsolutePath } from '@shared/lib/utils/workspace-path'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { nextFileVersion, type PreviewFileTab, type PreviewFolderTab } from '@renderer/hooks/use-file-preview-tabs'
import type { CommentAnchor } from '@renderer/components/file-preview/comments/kinds'
import { RELOADING_EVENT } from '@renderer/lib/lazy-with-reload'
import { useSessionTurn } from '@renderer/lib/session-turns'
import { reconcileEdits, type FileEdits } from '@renderer/components/file-preview/file-edits'
import { AgentFileOpenerContext, type AgentFileOpener } from './agent-file-opener-context'

/**
 * Where a file's bytes come from when it is not in the agent's workspace: a
 * shared drive's file, say, served from somewhere other than the agent files
 * API. Without one, the drawer reads `agentSlug`'s copy of the path.
 * HTTP(S) URLs must accept a `v` cache-busting parameter on each open;
 * data: and blob: URLs identify fixed bytes and are used unchanged.
 */
const previewSourceSchema = z.object({ inlineUrl: z.string(), downloadUrl: z.string().optional() })
export type PreviewSource = z.infer<typeof previewSourceSchema>

export interface FileTab extends PreviewFileTab {
  agentSlug: string
  source?: PreviewSource
  /** The file's ETag when this tab last loaded it, once the drawer has asked. */
  revision?: string
  /** What changed in it since the last turn that changed it, for markdown tabs in a session. */
  edits?: FileEdits
}

export interface FolderTab extends PreviewFolderTab {
  agentSlug: string
}

export type PreviewTab = FileTab | FolderTab

/** The folder equivalent: two agents can have a browser open on the same root. */
function isFolderTabFor(tab: PreviewTab, agentSlug: string, rootPath: string): tab is FolderTab {
  return tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.rootPath === rootPath
}

export interface FileComment {
  id: string
  filePath: string
  /** Which agent's copy of `filePath` this is feedback on. */
  agentSlug: string
  text: string
  anchor: CommentAnchor
}

/** What a comment says and where it points, without the file it is kept under. */
export type FileCommentContent = Pick<FileComment, 'anchor' | 'text'>

interface FilePreviewContextType {
  openTabs: PreviewTab[]
  activeTabIndex: number
  comments: Map<string, FileComment[]>
  isOpen: boolean
  commentsEnabled: boolean

  openFile: (filePath: string, agentSlug: string, description?: string, source?: PreviewSource) => void
  openFolder: (folderPath: string, agentSlug: string) => void
  toggleFolder: (rootPath: string, agentSlug: string, folderPath: string) => void
  setFolderQuery: (rootPath: string, agentSlug: string, query: string) => void
  selectFolderEntry: (rootPath: string, agentSlug: string, entryPath: string) => void
  renameFilePath: (oldPath: string, newPath: string, agentSlug: string) => void
  removeFilePath: (filePath: string, agentSlug: string) => void
  renameDirectoryPath: (oldPath: string, newPath: string, agentSlug: string) => void
  removeDirectoryPath: (directoryPath: string, agentSlug: string) => void
  closeTab: (tabKey: string) => void
  setActiveTab: (index: number) => void
  setPdfPage: (filePath: string, agentSlug: string, page: number) => void
  /** The file is at `revision` now: reload its tab if that is not the one it loaded. */
  reloadIfChanged: (filePath: string, agentSlug: string, revision: string) => void
  setShowEdits: (filePath: string, agentSlug: string, show: boolean) => void
  /** One file's edits; the one place the renderer looks them up. */
  editsFor: (filePath: string, agentSlug: string) => FileEdits | undefined
  /** The preview showed this text for the file: highlight what changed since it last showed it. */
  recordShownText: (filePath: string, agentSlug: string, text: string) => void
  close: () => void

  /** Comments on one agent's copy of a path; the one place the key is composed. */
  commentsFor: (filePath: string, agentSlug: string) => FileComment[]
  addComment: (comment: Omit<FileComment, 'id'>) => void
  removeComment: (filePath: string, agentSlug: string, commentId: string) => void
  clearComments: (filePath: string, agentSlug: string) => void
}

const FilePreviewContext = createContext<FilePreviewContextType | null>(null)

/** Tab and title label for a path. */
function getDisplayName(filePath: string): string {
  return getPathName(filePath)
}

function normalizeFolderPath(folderPath: string): string {
  return folderPath === '/' ? folderPath : folderPath.replace(/\/+$/, '')
}

/** The one spelling the drawer keys a path by: absolute, and without a folder's trailing slash. */
function previewPath(path: string): string {
  return normalizeFolderPath(toWorkspaceAbsolutePath(path))
}

function isPathAtOrBelow(basePath: string, candidatePath: string): boolean {
  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`)
}

function replacePathPrefix(candidatePath: string, oldPath: string, newPath: string): string {
  return isPathAtOrBelow(oldPath, candidatePath)
    ? `${newPath}${candidatePath.slice(oldPath.length)}`
    : candidatePath
}

let commentIdCounter = 0

const REOPEN_KEY = 'file-preview:reopen'
const ReopenFile = z.object({
  scope: z.string().nullable(), filePath: z.string(), agentSlug: z.string(),
  source: previewSourceSchema.optional(),
})

/** Read and clear the file a preview was opening when its tab reloaded onto a new build. */
function takeReopenFile(): z.infer<typeof ReopenFile> | null {
  const raw = sessionStorage.getItem(REOPEN_KEY)
  sessionStorage.removeItem(REOPEN_KEY)
  if (!raw) return null
  try {
    return ReopenFile.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** One shared empty array: a fresh [] per call would change every consumer's deps. */
const EMPTY_COMMENTS: FileComment[] = []

export function FilePreviewProvider({
  children,
  sessionId: sessionIdProp,
  sessionAgentSlug,
  commentsEnabled = false,
  rememberTabs = false,
}: {
  children: ReactNode
  sessionId?: string | null
  /** The session's agent. Its open markdown files highlight what changed since the last turn. */
  sessionAgentSlug?: string
  commentsEnabled?: boolean
  rememberTabs?: boolean
}) {
  const { view } = useRouteLocation()
  // Views that own a session (e.g. chat integrations) can pass it explicitly so
  // state clears when switching sessions; otherwise derive from the active route.
  const sessionId = sessionIdProp !== undefined ? sessionIdProp : (view.kind === 'session' ? view.id : null)

  return (
    <SessionTrayProvider sessionId={sessionId} agentSlug={rememberTabs ? sessionAgentSlug : undefined}>
      <FilePreviewState sessionId={sessionId} sessionAgentSlug={sessionAgentSlug} commentsEnabled={commentsEnabled}>
        {children}
      </FilePreviewState>
    </SessionTrayProvider>
  )
}

function FilePreviewState({ children, sessionId, sessionAgentSlug, commentsEnabled }: {
  children: ReactNode; sessionId: string | null; sessionAgentSlug?: string; commentsEnabled: boolean
}) {
  const tray = useRequiredTray()
  const { tabs, selected, hidden, comments } = useTrayState(tray)
  const openTabs = useMemo(() => tabs.flatMap(tab => tab.kind === 'file' ? [tab.file] : []), [tabs])
  const selectedIndex = openTabs.findIndex(tab => getPreviewTabKey(tab) === selected)
  const activeTabIndex = Math.max(0, selectedIndex)
  const isOpen = !hidden && selectedIndex >= 0
  const { mapFiles, openFileTab: openTab, setComments } = tray

  // A new turn makes the next change to a file start a new highlight.
  const turn = useSessionTurn(sessionAgentSlug ? sessionId : null)
  useEffect(() => {
    mapFiles(tab => tab.kind === 'file' && tab.edits
      ? { ...tab, edits: { ...tab.edits, fresh: true } } : tab)
  }, [turn, mapFiles])

  const openFile = useCallback((filePath: string, agentSlug: string, description?: string, source?: PreviewSource) => {
    const version = nextFileVersion()
    const path = previewPath(filePath)
    openTab({
      kind: 'file', filePath: path, agentSlug, displayName: getDisplayName(path),
      description, version, pdfPage: 1, source,
    }, existing => ({ ...existing, version, source }))
  }, [openTab])

  // A stale tab reloads itself when a view's files are gone after an upgrade. The file it
  // was opening is saved across that reload and opened again, so one click still opens it.
  const activeTab = isOpen ? openTabs[activeTabIndex] : undefined
  useEffect(() => {
    if (activeTab?.kind !== 'file') return
    const save = () => sessionStorage.setItem(REOPEN_KEY, JSON.stringify({
      scope: sessionId, filePath: activeTab.filePath, agentSlug: activeTab.agentSlug, source: activeTab.source,
    }))
    window.addEventListener(RELOADING_EVENT, save)
    return () => window.removeEventListener(RELOADING_EVENT, save)
  }, [activeTab, sessionId])

  // The first preview to mount after the reload takes the entry. Only the one that saved it reopens the file.
  useEffect(() => {
    const file = takeReopenFile()
    if (file?.scope === sessionId) openFile(file.filePath, file.agentSlug, undefined, file.source)
  }, [sessionId, openFile])

  const openFolder = useCallback((folderPath: string, agentSlug: string) => {
    const rootPath = previewPath(folderPath)
    openTab({
      kind: 'folder', rootPath, agentSlug, displayName: getDisplayName(rootPath),
      expandedPaths: [rootPath], query: '',
    })
  }, [openTab])

  const toggleFolder = useCallback((root: string, agentSlug: string, folder: string) => {
    const rootPath = previewPath(root)
    const folderPath = previewPath(folder)
    mapFiles(tab => {
      if (!isFolderTabFor(tab, agentSlug, rootPath) || folderPath === rootPath) return tab
      const expanded = new Set(tab.expandedPaths)
      if (expanded.has(folderPath)) expanded.delete(folderPath)
      else expanded.add(folderPath)
      return { ...tab, expandedPaths: Array.from(expanded) }
    })
  }, [mapFiles])

  const setFolderQuery = useCallback((rootPath: string, agentSlug: string, query: string) => {
    mapFiles(tab => (
      isFolderTabFor(tab, agentSlug, previewPath(rootPath)) ? { ...tab, query } : tab
    ))
  }, [mapFiles])

  const selectFolderEntry = useCallback((rootPath: string, agentSlug: string, entryPath: string) => {
    mapFiles(tab => (
      isFolderTabFor(tab, agentSlug, previewPath(rootPath)) ? { ...tab, selectedPath: previewPath(entryPath) } : tab
    ))
  }, [mapFiles])

  const renameFilePath = useCallback((oldName: string, newName: string, agentSlug: string) => {
    const oldPath = previewPath(oldName)
    const newPath = previewPath(newName)
    const version = nextFileVersion()
    mapFiles(tab => {
      if (tab.kind === 'file' && tab.agentSlug === agentSlug && tab.filePath === oldPath) {
        return {
          ...tab,
          filePath: newPath,
          displayName: getDisplayName(newPath),
          version,
        }
      }
      if (tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.selectedPath === oldPath) {
        return { ...tab, selectedPath: newPath }
      }
      return tab
    })
    setComments(prev => {
      const from = getWorkspaceFileKey(agentSlug, oldPath)
      const existing = prev.get(from)
      if (!existing) return prev
      const next = new Map(prev)
      next.delete(from)
      next.set(
        getWorkspaceFileKey(agentSlug, newPath),
        existing.map(comment => ({ ...comment, filePath: newPath })),
      )
      return next
    })
  }, [mapFiles])

  const closeTab = useCallback((tabKey: string) => {
    const closed = tray.snapshot().tabs.find(tab => tab.key === tabKey)
    if (closed?.kind !== 'file' || (closed.file.kind === 'folder' && closed.file.closable === false)) return
    tray.close(tabKey)
    if (closed.file.kind === 'file') {
      const key = getWorkspaceFileKey(closed.file.agentSlug, closed.file.filePath)
      setComments(current => {
        if (!current.has(key)) return current
        const next = new Map(current)
        next.delete(key)
        return next
      })
    }
  }, [tray, setComments])

  const removeFilePath = useCallback((name: string, agentSlug: string) => {
    const filePath = previewPath(name)
    closeTab(`file:${getWorkspaceFileKey(agentSlug, filePath)}`)
    mapFiles(tab => (
      tab.kind === 'folder' && tab.agentSlug === agentSlug && tab.selectedPath === filePath
        ? { ...tab, selectedPath: undefined }
        : tab
    ))
  }, [closeTab, mapFiles])

  const renameDirectoryPath = useCallback((oldName: string, newName: string, agentSlug: string) => {
    const oldPath = previewPath(oldName)
    const newPath = previewPath(newName)
    const version = nextFileVersion()
    mapFiles(tab => {
      if (tab.agentSlug !== agentSlug) return tab
      if (tab.kind === 'file') {
        const filePath = replacePathPrefix(tab.filePath, oldPath, newPath)
        return filePath === tab.filePath
          ? tab
          : { ...tab, filePath, displayName: getDisplayName(filePath), version }
      }

      const rootPath = replacePathPrefix(tab.rootPath, oldPath, newPath)
      const expandedPaths = Array.from(new Set(
        tab.expandedPaths.map(folderPath => replacePathPrefix(folderPath, oldPath, newPath)),
      ))
      const selectedPath = tab.selectedPath
        ? replacePathPrefix(tab.selectedPath, oldPath, newPath)
        : undefined
      return {
        ...tab,
        rootPath,
        displayName: rootPath === tab.rootPath ? tab.displayName : getDisplayName(rootPath),
        expandedPaths,
        selectedPath,
      }
    })
    setComments(prev => {
      let changed = false
      const next = new Map<string, FileComment[]>()
      for (const [key, fileComments] of prev) {
        // Every comment in a bucket shares the file it is on, so the first one
        // carries the bucket's identity — which beats parsing it back out of
        // the key, since a path may contain the separator.
        const owner = fileComments[0]
        const nextPath = owner && owner.agentSlug === agentSlug
          ? replacePathPrefix(owner.filePath, oldPath, newPath)
          : null
        if (!owner || nextPath === null || nextPath === owner.filePath) {
          next.set(key, fileComments)
          continue
        }
        changed = true
        next.set(
          getWorkspaceFileKey(agentSlug, nextPath),
          fileComments.map(comment => ({ ...comment, filePath: nextPath })),
        )
      }
      return changed ? next : prev
    })
  }, [mapFiles])

  const removeDirectoryPath = useCallback((directory: string, agentSlug: string) => {
    const directoryPath = previewPath(directory)
    mapFiles(tab => {
      if (tab.agentSlug !== agentSlug) return tab
      if (isPathAtOrBelow(directoryPath, tab.kind === 'file' ? tab.filePath : tab.rootPath)) return null
      if (tab.kind !== 'folder') return tab
      const expandedPaths = tab.expandedPaths.filter(path => !isPathAtOrBelow(directoryPath, path))
      const selectedPath = tab.selectedPath && isPathAtOrBelow(directoryPath, tab.selectedPath) ? undefined : tab.selectedPath
      return { ...tab, expandedPaths, selectedPath }
    })
    setComments(prev => {
      const next = new Map(prev)
      let changed = false
      for (const [key, fileComments] of prev) {
        const owner = fileComments[0]
        if (!owner || owner.agentSlug !== agentSlug) continue
        if (isPathAtOrBelow(directoryPath, owner.filePath)) {
          next.delete(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [mapFiles, setComments])

  const setActiveTab = useCallback((index: number) => {
    const tab = openTabs[index]
    if (tab) tray.select(getPreviewTabKey(tab))
  }, [tray, openTabs])

  const setPdfPage = useCallback((name: string, agentSlug: string, page: number) => {
    const path = previewPath(name)
    const pdfPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
    mapFiles(tab => tab.kind === 'file' && tab.filePath === path && tab.agentSlug === agentSlug && tab.pdfPage !== pdfPage
      ? { ...tab, pdfPage } : tab)
  }, [mapFiles])

  const reloadIfChanged = useCallback((name: string, agentSlug: string, revision: string) => {
    const path = previewPath(name)
    const version = nextFileVersion()
    mapFiles(tab => {
      if (tab.kind !== 'file' || tab.agentSlug !== agentSlug || tab.filePath !== path || tab.revision === revision) return tab
      return tab.revision === undefined ? { ...tab, revision } : { ...tab, revision, version }
    })
  }, [mapFiles])

  const editsFor = useCallback((name: string, agentSlug: string) => {
    const filePath = previewPath(name)
    const tab = openTabs.find(t => t.kind === 'file' && t.agentSlug === agentSlug && t.filePath === filePath)
    return tab?.kind === 'file' ? tab.edits : undefined
  }, [openTabs])

  // Only the session's own agent keeps copies to diff: a highlight follows this
  // session's turns, and another agent's changes do not.
  const recordShownText = useCallback((name: string, agentSlug: string, text: string) => {
    if (!sessionAgentSlug || agentSlug !== sessionAgentSlug) return
    const filePath = previewPath(name)
    mapFiles(tab => {
      if (tab.kind !== 'file' || tab.agentSlug !== agentSlug || tab.filePath !== filePath) return tab
      const edits = reconcileEdits(tab.edits, text)
      return edits === tab.edits ? tab : { ...tab, edits }
    })
  }, [sessionAgentSlug, mapFiles])

  const setShowEdits = useCallback((name: string, agentSlug: string, show: boolean) => {
    const filePath = previewPath(name)
    mapFiles(tab => (
      tab.kind === 'file' && tab.edits && tab.agentSlug === agentSlug && tab.filePath === filePath
        ? { ...tab, edits: { ...tab.edits, show } }
        : tab
    ))
  }, [mapFiles])

  const close = tray.hide

  const commentsFor = useCallback((filePath: string, agentSlug: string) => (
    comments.get(getWorkspaceFileKey(agentSlug, previewPath(filePath))) ?? EMPTY_COMMENTS
  ), [comments])

  const addComment = useCallback((comment: Omit<FileComment, 'id'>) => {
    if (!commentsEnabled) return
    const id = `comment-${++commentIdCounter}`
    const filePath = previewPath(comment.filePath)
    const key = getWorkspaceFileKey(comment.agentSlug, filePath)
    setComments(prev => {
      const next = new Map(prev)
      next.set(key, [...(next.get(key) ?? []), { ...comment, filePath, id }])
      return next
    })
  }, [commentsEnabled])

  const removeComment = useCallback((filePath: string, agentSlug: string, commentId: string) => {
    const key = getWorkspaceFileKey(agentSlug, previewPath(filePath))
    setComments(prev => {
      const existing = prev.get(key)
      if (!existing) return prev
      const next = new Map(prev)
      const filtered = existing.filter(c => c.id !== commentId)
      if (filtered.length === 0) next.delete(key)
      else next.set(key, filtered)
      return next
    })
  }, [])

  const clearComments = useCallback((filePath: string, agentSlug: string) => {
    const key = getWorkspaceFileKey(agentSlug, previewPath(filePath))
    setComments(prev => {
      if (!prev.has(key)) return prev
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }, [])

  const value = useMemo<FilePreviewContextType>(() => ({
    openTabs,
    activeTabIndex,
    comments,
    isOpen,
    commentsEnabled,
    openFile,
    openFolder,
    toggleFolder,
    setFolderQuery,
    selectFolderEntry,
    renameFilePath,
    removeFilePath,
    renameDirectoryPath,
    removeDirectoryPath,
    closeTab,
    setActiveTab,
    setPdfPage,
    reloadIfChanged,
    setShowEdits,
    editsFor,
    recordShownText,
    close,
    commentsFor,
    addComment,
    removeComment,
    clearComments,
  }), [openTabs, activeTabIndex, comments, isOpen, commentsEnabled, openFile, openFolder, toggleFolder, setFolderQuery, selectFolderEntry, renameFilePath, removeFilePath, renameDirectoryPath, removeDirectoryPath, closeTab, setActiveTab, setPdfPage, reloadIfChanged, setShowEdits, editsFor, recordShownText, close, commentsFor, addComment, removeComment, clearComments])

  const opener = useMemo<AgentFileOpener>(() => ({ openFile, openFolder }), [openFile, openFolder])

  return (
    <FilePreviewContext.Provider value={value}>
      <AgentFileOpenerContext.Provider value={opener}>
        {children}
      </AgentFileOpenerContext.Provider>
    </FilePreviewContext.Provider>
  )
}

export function useFilePreview(): FilePreviewContextType {
  const ctx = useContext(FilePreviewContext)
  if (!ctx) throw new Error('useFilePreview must be used within FilePreviewProvider')
  return ctx
}
