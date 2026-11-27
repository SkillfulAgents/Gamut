import { useMemo, useState, type ReactNode } from 'react'
import { folderNameError } from '@shared/lib/volumes/volume-folders-schema'
import { useCreateVolumeFolder } from '@renderer/hooks/use-volume-folders'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { VolumeFolderPicker, type VolumeFolderSource } from './volume-folder-picker'
import { VolumeSetupFooter } from './volume-setup-layout'

type MadeFolder = { id: string; name: string }

/** A source's picker, worded for choosing where a new folder goes rather than which folder to use. */
function parentPicker<Cursor>(source: VolumeFolderSource<Cursor>): VolumeFolderSource<Cursor> {
  return {
    ...source,
    fieldLabel: 'Create in',
    title: 'Choose where the new folder goes',
    description: 'Select the folder to create it in, or open one to look inside it.',
    confirmVerb: 'Create in',
    confirmLabel: cursor => source.confirmLabel(cursor) === null ? null : `Create in “${source.crumbs(cursor).at(-1)?.name}”`,
    // The one folder this step makes is the new one; the place it goes is somewhere already there.
    canCreate: undefined,
  }
}

/** Where a place is, from the source's top down: "My Drive / Projects", or the source's own name at its top. */
function placeName<Cursor>(source: VolumeFolderSource<Cursor>, cursor: Cursor): string {
  const [top, ...rest] = source.crumbs(cursor)
  return rest.length ? rest.map(crumb => crumb.name).join(' / ') : top.name
}

/**
 * The details step when the host asked for a new folder (`VolumeSetupFolderContext` 'new', Team Brain's "create a new
 * one"): name the folder, say where it goes when the source has places to put it, and the step makes it on save, then
 * hands the host the made folder as the drive's config.
 *
 * A folder made here is remembered, so a save that fails afterwards (reading the new repository's branch, or the
 * host's own work) tries again with that folder instead of making a second.
 */
export function VolumeNewFolderStep<Cursor>({
  source, noun = 'folder', accountId, account, defaultName, where, toConfig, onSubmit, onBack, onCancel, isSaving, error, clearError, children,
}: {
  source: VolumeFolderSource<Cursor>
  /** What is made, in the source's words: "folder", "repository", "drive". */
  noun?: string
  accountId: string
  /** The chosen account, for a source that has accounts. */
  account?: { name: string | undefined; active: boolean }
  defaultName: string
  /**
   * Where the new folder goes. A source with places to put it has the person `pick` one, opening at `initial` with
   * `preset` chosen once the source knows it; a source with one place (a GitHub account, the org's drives) makes it at `initial`.
   */
  where: { initial: Cursor; pick: boolean; preset?: Cursor }
  /** The made folder as the drive's config. Read-only, so a retry can ask again. */
  toConfig: (folder: MadeFolder, parent: Cursor) => unknown
  onSubmit: (config: unknown) => Promise<void>
  onBack: () => void
  onCancel: () => void
  isSaving: boolean
  error: string | null
  clearError: () => void
  children?: ReactNode
}) {
  const create = useCreateVolumeFolder(source)
  const picker = useMemo(() => parentPicker(source), [source])
  const [name, setName] = useState(defaultName)
  const [picked, setPicked] = useState<Cursor>()
  const [made, setMade] = useState<{ key: string; folder: MadeFolder } | null>(null)
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // Undefined until there is a place: a cursor of its own can be null (the org's drives).
  const parent = where.pick ? picked ?? where.preset : where.initial
  const placed = !where.pick || parent !== undefined
  const active = account?.active ?? true
  const busy = working || isSaving
  const reset = () => { setProblem(null); clearError() }

  const submit = async () => {
    if (busy || !active || !placed) return
    const invalid = folderNameError(name)
    if (invalid) { setProblem(invalid); return }
    reset()
    setWorking(true)
    try {
      const query = source.query(accountId, parent as Cursor)
      const key = JSON.stringify([query, name.trim()])
      let folder = made?.key === key ? made.folder : null
      if (!folder) {
        folder = await create.mutateAsync({ query, name: name.trim() })
        setMade({ key, folder })
      }
      await onSubmit(await toConfig(folder, parent as Cursor))
    } catch (err) {
      setProblem(err instanceof Error ? err.message : `Could not create the ${noun}. Please try again.`)
    } finally { setWorking(false) }
  }

  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit() }}>
    {account && <p className="rounded-item bg-muted/50 px-3 py-2 text-sm" data-testid="selected-volume-account">{account.name ?? `${source.label} account`}</p>}
    {!active && <p role="alert" className="text-sm text-destructive">This account is unavailable. Go back to choose or connect a {source.label} account.</p>}
    <div className="space-y-2">
      <Label htmlFor="volume-folder-name">{noun[0].toUpperCase() + noun.slice(1)} name</Label>
      <Input id="volume-folder-name" value={name} onChange={event => { setName(event.target.value); reset() }} maxLength={255} disabled={busy} required />
    </div>
    {/* Remounted when the preset arrives, so the picker opens at it. */}
    {where.pick && <VolumeFolderPicker key={`${accountId}:${where.preset ? 'preset' : 'open'}`} source={picker} accountId={accountId}
      initial={where.preset ?? where.initial} selected={parent === undefined ? null : placeName(source, parent)} disabled={busy || !active}
      onChange={cursor => { setPicked(cursor); reset() }} />}
    {children}
    {(problem ?? error) && <p role="alert" className="text-sm text-destructive">{problem ?? error}</p>}
    <VolumeSetupFooter onBack={onBack} onCancel={onCancel} isSaving={busy} disabled={!active || !name.trim() || !placed} submitLabel={`Create ${noun}`} />
  </form>
}
