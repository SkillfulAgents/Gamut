import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { AgentFileOpenerContext } from './agent-file-opener-context'
import { SessionTray } from '@renderer/components/tray/session-tray'

import { trayResidents } from '@renderer/components/tray/tray-residents'

const TrayContext = createContext<SessionTray | null>(null)
const recent = new Map<string, SessionTray>()

function sessionTray(agent: string | undefined, session: string | null) {
  if (!agent || !session) return new SessionTray(trayResidents)
  // Switching workspace reloads the renderer. This map lives for that one workspace.
  const key = JSON.stringify([agent, session])
  const tray = recent.get(key) ?? new SessionTray(trayResidents)
  recent.delete(key)
  recent.set(key, tray)
  if (recent.size > 50) recent.delete(recent.keys().next().value!)
  return tray
}

export function SessionTrayProvider({ agentSlug, sessionId, children }: {
  agentSlug?: string; sessionId: string | null; children: ReactNode
}) {
  const value = useMemo(() => sessionTray(agentSlug, sessionId), [agentSlug, sessionId])
  return <TrayContext.Provider value={value}>{children}</TrayContext.Provider>
}

/** An embedded session has its own transcript, and cannot open its host's tray. */
export function WithoutSessionTray({ children }: { children: ReactNode }) {
  return (
    <TrayContext.Provider value={null}>
      <AgentFileOpenerContext.Provider value={null}>{children}</AgentFileOpenerContext.Provider>
    </TrayContext.Provider>
  )
}

export function useSessionTray() { return useContext(TrayContext) }
export function useRequiredTray() {
  const tray = useSessionTray()
  if (!tray) throw new Error('Session tray provider missing')
  return tray
}
export function useTrayState(tray: SessionTray) {
  return useSyncExternalStore(tray.subscribe, tray.snapshot)
}
