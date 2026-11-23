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
  keyFor?: (target: unknown) => string
  titleFor?: (target: unknown) => string
  renderPanel: (tray: SessionTray, scope: TrayScope, target: unknown) => ReactNode
}

export function defineTrayResident<K extends UtilityId>(resident: {
  id: K
  label: string
  Icon: ComponentType<{ className?: string }>
  /** Omit for one shared tab. A stable key per resource contributes peers to the strip. */
  keyFor?: (target: TrayUtilityTargets[K] | null) => string
  titleFor?: (target: TrayUtilityTargets[K] | null) => string
  Panel: ComponentType<TrayPanelProps<TrayUtilityTargets[K]>>
  Count?: ComponentType<TrayScope>
}): RegisteredResident {
  const { id, Panel } = resident
  return {
    id, label: resident.label, Icon: resident.Icon, Count: resident.Count,
    keyFor: resident.keyFor as RegisteredResident['keyFor'],
    titleFor: resident.titleFor as RegisteredResident['titleFor'],
    renderPanel(tray, scope, target) {
      // openUtility accepts only the target declared for this resident's id.
      return <Panel {...scope} target={target as TrayUtilityTargets[K]} openDetail={detail => tray.openUtility(id, detail)} />
    },
  }
}
