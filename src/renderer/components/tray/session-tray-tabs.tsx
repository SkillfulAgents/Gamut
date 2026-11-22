import { Globe, Plus } from 'lucide-react'
import { BrowserTabIcon, browserTabLabel } from '@renderer/components/browser/browser-tab-bar'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { WorkflowIcon } from '@renderer/components/workflow/workflow-icon'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import type { TrayEntry } from './session-tray'
import { TrayTabLiveDot, type TrayTab } from './tray-tabs'
import { trayResidents } from './tray-residents'
import type { TrayScope } from './tray-resident'

function WorkflowBadge({ scope, runId }: { scope: TrayScope; runId: string }) {
  const { workflows } = useMessageStream(scope.sessionId, scope.agentSlug, ['workflows'])
  return workflows?.some(run => run.runId === runId && run.completedAt === undefined) ? <TrayTabLiveDot /> : null
}

export function describeTrayTab(entry: TrayEntry, scope: TrayScope, onSelect: () => void, onClose: () => void): TrayTab {
  const common = { key: entry.key, onSelect, onClose }
  switch (entry.kind) {
    case 'browser': {
      const page = entry.page
      if (!page) return { ...common, kind: 'browser', label: 'Browser', icon: <Globe size={14} />, onClose: undefined }
      const label = browserTabLabel(page)
      return { ...common, kind: 'browser', label, title: page.title || page.url,
        icon: <BrowserTabIcon faviconUrl={page.faviconUrl} title={label} />,
        badge: page.active && <TrayTabLiveDot />, onClose: page.active ? undefined : onClose }
    }
    case 'file': {
      const file = entry.file
      const path = file.kind === 'file' ? file.filePath : file.rootPath
      return { ...common, kind: 'file', label: file.displayName, title: path,
        icon: <FileTypeIcon filename={file.displayName} folder={file.kind === 'folder'} size="sm" />,
        onClose: file.kind === 'folder' && file.closable === false ? undefined : onClose,
        data: { 'data-tab-kind': file.kind, 'data-file-name': file.displayName, 'data-path': path } }
    }
    case 'workflow':
      return { ...common, kind: 'workflow', label: entry.name ?? 'Workflow', icon: <WorkflowIcon size={14} />,
        badge: <WorkflowBadge scope={scope} runId={entry.runId} /> }
    case 'utility': {
      const resident = trayResidents.find(item => item.id === entry.id)!
      return { ...common, kind: 'utility', label: resident.label, icon: <resident.Icon className="h-3.5 w-3.5" /> }
    }
    case 'new':
      return { ...common, kind: 'new', label: 'New tab', icon: <Plus size={14} /> }
  }
}
