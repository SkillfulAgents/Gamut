/**
 * The drawer is one white card, 8px in from its column's sides and bottom, with a very faint edge and a very soft
 * shadow. Above it the tabs stand on the page, Chrome-style (DrawerTabStrip's `floating`), and the front tab joins
 * it. A body draws no card of its own: it fills TRAY_BODY_CLASS.
 */
export const TRAY_PANEL_CLASS =
  'tray-panel relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden rounded-card border border-[color:var(--tray-edge-color)] bg-background'

export const TRAY_BODY_CLASS = 'flex flex-1 min-h-0 flex-col'
