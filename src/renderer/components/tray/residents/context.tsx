import { Gauge } from 'lucide-react'
import { defineTrayResident } from '../tray-resident'
import { ContextTrayContent } from '../context-tray-content'

declare module '../tray-resident' {
  interface TrayUtilityTargets {
    context: null
  }
}

export default defineTrayResident({
  id: 'context',
  label: 'Context',
  Icon: Gauge,
  Panel: ContextTrayContent,
})
