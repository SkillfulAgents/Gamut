import type { SessionTray } from './session-tray'
import type { ComponentType, ReactNode } from 'react'

/** Residents extend this interface with their detail target, including null for their list. */
export interface TrayUtilityTargets {}
export type UtilityId = keyof TrayUtilityTargets & string
export type TrayScope = { agentSlug: string; sessionId: string }
export interface TrayPanelProps<T> extends TrayScope {
  target: T
  openDetail: (target: T) => void
}

export interface RegisteredResident {
  id: UtilityId
  label: string
  Icon: ComponentType<{ className?: string }>
  Count?: ComponentType<TrayScope>
  renderPanel: (tray: SessionTray, scope: TrayScope, target: unknown) => ReactNode
}

export function defineTrayResident<K extends UtilityId>(resident: {
  id: K
  label: string
  Icon: ComponentType<{ className?: string }>
  Panel: ComponentType<TrayPanelProps<TrayUtilityTargets[K]>>
  Count?: ComponentType<TrayScope>
}): RegisteredResident {
  const { id, Panel } = resident
  return {
    ...resident,
    renderPanel(tray, scope, target) {
      // openUtility accepts only the target declared for this resident's id.
      return <Panel {...scope} target={target as TrayUtilityTargets[K]} openDetail={detail => tray.openUtility(id, detail)} />
    },
  }
}
