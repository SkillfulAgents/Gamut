import { useState } from 'react'
import { ArrowUpRight, PanelRight, Pencil, PinOff } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { SiteFavicon } from '@renderer/components/ui/site-favicon'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@renderer/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { useBookmarks, useUpdateBookmarks } from '@renderer/hooks/use-bookmarks'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { bookmarkTarget, type Bookmark, type BookmarkTarget } from '@shared/lib/utils/bookmarks'
import { HomeGlassPanel } from './home-glass-panel'
import { getPathName } from '@shared/lib/utils/workspace-path'

/**
 * The panel's filter. Only the kinds it holds get a tab, and none shows at all
 * while it holds one kind: a tab that would list nothing, or the same rows as
 * All, is only noise.
 */
type PinFilter = 'all' | BookmarkTarget['kind']
const PIN_KINDS: BookmarkTarget['kind'][] = ['file', 'folder', 'link']
const FILTER_LABELS: Record<PinFilter, string> = {
  all: 'All',
  file: 'Files',
  folder: 'Folders',
  link: 'Links',
}
/** What unpinning leaves behind, said in the confirmation. */
const UNPIN_NOTE: Record<BookmarkTarget['kind'], string> = {
  file: 'The file stays in the workspace.',
  folder: 'The folder stays in the workspace.',
  link: 'Only the agent can pin a link again.',
}

interface HomeBookmarksProps {
  agentSlug: string
  isOwner?: boolean
}

/**
 * The site's `/favicon.ico`, or a globe where it has none (or refuses it): the same guess
 * Settings → Logins makes, through the same guard against icons on private hosts.
 */
function LinkIcon({ link }: { link: string }) {
  let origin: string | null = null
  try {
    origin = new URL(link).origin
  } catch {
    // Not a URL; the globe stands in.
  }
  // stroke-1: the globe's lines at the file-type icons' weight in the rows beside it (their strokeWidth={1}),
  // not lucide's default 2. A loaded favicon's plate ignores it.
  return <SiteFavicon src={origin ? `${origin}/favicon.ico` : undefined} className="h-4 w-4 stroke-1" />
}

function BookmarkRow({
  bookmark,
  isOwner,
  onRename,
  onDelete,
  onOpenFile,
  onOpenFolder,
}: {
  bookmark: Bookmark
  isOwner: boolean
  onRename: () => void
  onDelete: () => void
  onOpenFile: (filePath: string) => void
  onOpenFolder: (folderPath: string) => void
}) {
  const target = bookmarkTarget(bookmark)
  // A bookmark carrying none of link/file/folder is not one the type allows and
  // not one the server stores; if the API returns one anyway, draw nothing.
  if (!target) return null

  const inner = target.kind === 'link' ? (
    <a
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-3 py-2.5 px-1 hover:bg-muted/50 transition-colors"
    >
      <LinkIcon link={target.url} />
      <span className="text-xs truncate">{bookmark.name}</span>
      <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
    </a>
  ) : (
    <button
      type="button"
      onClick={() => target.kind === 'folder' ? onOpenFolder(target.path) : onOpenFile(target.path)}
      className="group flex w-full items-center gap-3 py-2.5 px-1 text-left hover:bg-muted/50 transition-colors"
      title={`${target.kind === 'folder' ? 'Browse' : 'Preview'} ${getPathName(target.path)}`}
      aria-label={bookmark.name}
    >
      <FileTypeIcon
        filename={getPathName(target.path)}
        size="md"
        folder={target.kind === 'folder'}
        className="text-muted-foreground"
      />
      <span className="text-xs truncate">{bookmark.name}</span>
      <PanelRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
    </button>
  )

  if (!isOwner) return inner

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {inner}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onRename}>
          <Pencil className="h-3.5 w-3.5 mr-2" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onDelete}>
          <PinOff className="h-3.5 w-3.5 mr-2" />
          Unpin
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function HomeBookmarks({ agentSlug, isOwner = false }: HomeBookmarksProps) {
  const { openFile, openFolder } = useFilePreview()
  const { data: bookmarks } = useBookmarks(agentSlug)
  const updateBookmarks = useUpdateBookmarks(agentSlug)
  const [renameIndex, setRenameIndex] = useState<number | null>(null)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [newName, setNewName] = useState('')
  const [filter, setFilter] = useState<PinFilter>('all')

  if (!bookmarks || bookmarks.length === 0) return null

  // Each row keeps its index in the file, which rename and unpin write back by.
  const rows = bookmarks.map((bookmark, index) => ({ bookmark, index, kind: bookmarkTarget(bookmark)?.kind }))
  const kinds = PIN_KINDS.filter(kind => rows.some(row => row.kind === kind))
  // A filter whose last pin went falls back to All rather than an empty list.
  const active: PinFilter = filter !== 'all' && kinds.includes(filter) ? filter : 'all'
  const shown = active === 'all' ? rows : rows.filter(row => row.kind === active)
  const deleteTarget = deleteIndex != null ? bookmarks[deleteIndex] : undefined
  const deleteKind = deleteTarget ? bookmarkTarget(deleteTarget)?.kind : undefined

  const handleRename = async () => {
    if (renameIndex == null || !bookmarks) return
    const trimmed = newName.trim()
    if (!trimmed || trimmed === bookmarks[renameIndex].name) {
      setRenameIndex(null)
      return
    }
    const updated = bookmarks.map((b, i) => i === renameIndex ? { ...b, name: trimmed } : b)
    await updateBookmarks.mutateAsync(updated)
    setRenameIndex(null)
  }

  const handleDelete = async () => {
    if (deleteIndex == null || !bookmarks) return
    const updated = bookmarks.filter((_, i) => i !== deleteIndex)
    await updateBookmarks.mutateAsync(updated)
    setDeleteIndex(null)
  }

  const list = (
    <div className="divide-y divide-border/50">
      {shown.map(({ bookmark, index }) => (
        <BookmarkRow
          key={bookmark.link ?? bookmark.file ?? bookmark.folder ?? index}
          bookmark={bookmark}
          isOwner={isOwner}
          onRename={() => { setNewName(bookmark.name); setRenameIndex(index) }}
          onDelete={() => setDeleteIndex(index)}
          onOpenFile={(filePath) => openFile(filePath, agentSlug)}
          onOpenFolder={(folderPath) => openFolder(folderPath, agentSlug)}
        />
      ))}
    </div>
  )

  const filterTabs = kinds.length > 1 && (
    <TabsList aria-label="Filter pinned items" className="h-6 p-0.5">
      {(['all', ...kinds] as PinFilter[]).map(kind => (
        <TabsTrigger
          key={kind}
          value={kind}
          data-testid={`home-pinned-filter-${kind}`}
          className="h-5 px-2 py-0 text-xs"
        >
          {FILTER_LABELS[kind]}
        </TabsTrigger>
      ))}
    </TabsList>
  )

  const panel = (
    // Its own glass panel, under Recent sessions; there is none at all with nothing pinned.
    <HomeGlassPanel title="Pinned Items" testId="home-bookmarks" actions={filterTabs}>
      {filterTabs ? <TabsContent value={active} className="mt-0">{list}</TabsContent> : list}

      <Dialog open={renameIndex != null} onOpenChange={(open) => { if (!open) setRenameIndex(null) }}>
        <DialogContent className="overflow-hidden">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
            <DialogDescription>Choose the name it shows in Pinned Items.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); handleRename() }}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenameIndex(null)}>Cancel</Button>
              <Button type="submit" disabled={updateBookmarks.isPending || !newName.trim()}>
                {updateBookmarks.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteIndex != null} onOpenChange={(open) => { if (!open) setDeleteIndex(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpin “{deleteTarget?.name ?? ''}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It comes off this list.{deleteKind ? ` ${UNPIN_NOTE[deleteKind]}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={updateBookmarks.isPending}>
              {updateBookmarks.isPending ? 'Unpinning...' : 'Unpin'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </HomeGlassPanel>
  )

  return filterTabs ? (
    <Tabs value={active} onValueChange={(value) => setFilter(value as PinFilter)}>{panel}</Tabs>
  ) : panel
}
