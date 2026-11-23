import { FileTypeIcon } from './file-type-icon'
import { useAgentFileOpener } from '@renderer/context/agent-file-opener-context'
import { openableProps } from '@renderer/lib/openable'
import { describeWorkspaceFile } from '@renderer/lib/workspace-file'

interface FileDownloadPillProps {
  filePath: string
  agentSlug: string
}

const PILL_CLASS = 'file-pill inline-flex items-center gap-1 px-2 py-0.5 rounded-item border text-xs text-muted-foreground'

export function FileDownloadPill({ filePath, agentSlug }: FileDownloadPillProps) {
  const opener = useAgentFileOpener()
  const file = describeWorkspaceFile(filePath, agentSlug)

  // The pill sits inside the tool disclosure. Opening a file must not also
  // expand the tool. Folders and transcripts without a drawer show its name.
  const canOpen = opener && !file.isFolder
  return (
    <span
      className={canOpen ? `${PILL_CLASS} hover:text-foreground hover:bg-muted cursor-pointer` : PILL_CLASS}
      data-testid="file-pill"
      data-file-name={file.name}
      data-file-path={file.path}
      {...(canOpen && openableProps(() => opener.openFile(file.path, file.agentSlug), { stopPropagation: true }))}
    >
      <FileTypeIcon filename={file.name} size="sm" folder={file.isFolder} />
      {file.name}
    </span>
  )
}
