import { describe, expect, it } from 'vitest'
import type { NotMountedReason } from '@shared/lib/types/mount'
import { driveProblemLine } from './drive-problem-line'

describe('driveProblemLine', () => {
  it.each<[NotMountedReason, string, boolean]>([
    ['ready after a restart', 'Notes is back. Restart the agent to mount it.', true],
    ['unreadable', "Notes didn't mount. Restart to try again.", true],
    ['not accessible', "Notes can't be reached. Check its account or folder access, then restart.", false],
    ['not found', "Notes's folder no longer exists.", false],
    ['pick the folder again', "Choose Notes's folder again.", false],
    ['invalid name', 'Rename Notes to mount it.', false],
    ['not supported here', "Drives can't mount in this runtime.", false],
    ['preparing', "Notes is still copying. It mounts after a restart once it's ready.", false],
  ])('%s', (reason, text, restart) => {
    expect(driveProblemLine({ name: 'Notes', reason })).toEqual({ text, restart })
  })
})
