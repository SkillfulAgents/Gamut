import type { NotMountedVolume } from '@shared/lib/types/mount'

/** What the banner says about a drive the agent started without, and whether a restart can bring it in. */
export function driveProblemLine({ name, reason }: NotMountedVolume): { text: string; restart: boolean } {
  switch (reason) {
    case 'ready after a restart':
      return { text: `${name} is back. Restart the agent to mount it.`, restart: true }
    case 'unreadable':
    case 'failed in the agent':
    case 'not confirmed':
    case 'start failed with folders':
      return { text: `${name} didn't mount. Restart to try again.`, restart: true }
    case 'not accessible':
      return { text: `${name} can't be reached. Check its account or folder access, then restart.`, restart: false }
    case 'not found':
      return { text: `${name}'s folder no longer exists.`, restart: false }
    case 'pick the folder again':
      return { text: `Choose ${name}'s folder again.`, restart: false }
    case 'invalid name':
      return { text: `Rename ${name} to mount it.`, restart: false }
    case 'not supported here':
      return { text: "Drives can't mount in this runtime.", restart: false }
    default:
      // A first copy still running or failed. A reason added later fails to compile here until it has a line.
      reason satisfies 'preparing' | `preparing: ${string}`
      return { text: `${name} is still copying. It mounts after a restart once it's ready.`, restart: false }
  }
}
