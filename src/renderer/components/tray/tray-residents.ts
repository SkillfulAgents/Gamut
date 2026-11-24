import type { RegisteredResident } from './tray-resident'

export const trayResidents = Object.values(import.meta.glob<RegisteredResident>(['./residents/*.tsx', '!./residents/*.test.tsx'], {
  eager: true, import: 'default',
}))
