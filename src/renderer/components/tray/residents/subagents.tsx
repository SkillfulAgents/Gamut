import { Workflow } from 'lucide-react'
import { defineTrayResident } from '../tray-resident'
import { SubagentsTrayContent } from '../subagents-tray-content'

declare module '../tray-resident' {
  interface TrayUtilityTargets {
    subagents: string | null
  }
}

export default defineTrayResident({ id: 'subagents', label: 'Subagents', Icon: Workflow, Panel: SubagentsTrayContent })
