import { SquareArrowRight } from 'lucide-react'
import { defineTrayResident } from '../tray-resident'
import { AgentSessionsTrayContent, type AgentCallTab } from '../agent-sessions-tray-content'

declare module '../tray-resident' {
  interface TrayUtilityTargets {
    'invoked-agents': AgentCallTab | null
  }
}

export default defineTrayResident({
  id: 'invoked-agents', label: 'Invoked agents', Icon: SquareArrowRight, Panel: AgentSessionsTrayContent,
})
