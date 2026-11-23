import type { ReactNode } from 'react'
import { SessionTrayProvider, useRequiredTray, useSessionTray } from './session-tray-context'

/** Standalone workflow views get a tray. Session and file hosts already supply one. */
export function WorkflowProvider({ children, sessionId }: { children: ReactNode; sessionId?: string | null }) {
  const tray = useSessionTray()
  return tray ? children : <SessionTrayProvider sessionId={sessionId ?? null}>{children}</SessionTrayProvider>
}

/** Some transcripts are embedded without a workflow drawer. */
export function useOpenWorkflow() {
  return useSessionTray()?.openWorkflow
}

export function useWorkflow() {
  const { openWorkflow, viewWorkflowAgent } = useRequiredTray()
  return { openWorkflow, viewWorkflowAgent }
}
