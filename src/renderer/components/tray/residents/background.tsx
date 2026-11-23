import { SquareTerminal } from 'lucide-react'
import { defineTrayResident } from '../tray-resident'
import { BackgroundTasksTrayContent } from '../background-tasks-tray-content'
import { useSessionBackgroundTasks } from '@renderer/context/session-background-tasks-context'

declare module '../tray-resident' {
  interface TrayUtilityTargets {
    background: string | null
  }
}

function Count() {
  const tasks = useSessionBackgroundTasks()
  const count = tasks?.commands.length
  if (!count) return null
  return (
    <span className="text-xs tabular-nums text-muted-foreground" title="Running and finished background tasks in this session">
      {count}{tasks?.hasOlder ? '+' : ''}
    </span>
  )
}

export default defineTrayResident({
  id: 'background',
  label: 'Background tasks',
  Icon: SquareTerminal,
  Panel: BackgroundTasksTrayContent,
  Count,
})
