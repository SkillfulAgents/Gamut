/**
 * The harness's own page reads — the status line, an action's before/after
 * observation, the reader, the scroll and wait probes — describe the
 * session's page: its top frame. They run through the CLI's `eval`, which
 * since agent-browser 0.45 runs in the frame the agent selected with
 * `frame <target>` (upstream #2738); at 0.41 it always ran on the top frame.
 *
 * So every probe checks where it ran. On the top frame it answers as before,
 * at no extra cost. Inside a frame it answers a marker instead, and the
 * caller steps out (`frame main`), reads, and selects the agent's frame again
 * (stepOutOfFrame). The agent's own `browser_eval` keeps the CLI's behavior.
 */

/** What a probe answers when it ran inside a frame rather than on the top page. */
export const IN_FRAME_MARKER = '__gamut_probe_in_frame__'

/**
 * `script` (an expression) for the top frame only: inside a frame it yields
 * IN_FRAME_MARKER instead of running. Comparing window objects is allowed
 * across origins, so this works in a cross-origin frame too.
 */
export function topFrameScript(script: string): string {
  return `(window.top !== window ? ${JSON.stringify(IN_FRAME_MARKER)} : (${script}))`
}

/** Whether a probe's output is the marker: it ran inside a frame. */
export function ranInFrame(stdout: string): boolean {
  return stdout.trim() === JSON.stringify(IN_FRAME_MARKER)
}

/**
 * The frame selection a browser_run leaves, from the CLI commands it ran
 * (runCommands: a `batch` is one command per argument): the target of the
 * last `frame` command, null when that was `frame main`, undefined when none
 * selected a frame. A command that fails stops a batch, so the caller applies
 * this only when the run succeeded.
 */
export function frameSelectionOf(commands: string[][]): string | null | undefined {
  let selection: string | null | undefined
  for (const command of commands) {
    if (command[0]?.toLowerCase() !== 'frame') continue
    const target = command.slice(1).find((arg) => arg !== '--')
    if (target === undefined) continue
    selection = target === 'main' ? null : target
  }
  return selection
}

interface ProbeSession {
  frame: string | null
  frameStep: Promise<void> | null
}

type Run = (args: string[]) => Promise<{ stdout: string; exitCode: number }>

/**
 * Run `script` on the top frame while the agent has a frame selected: step
 * out, read, and select the agent's frame again (atTopFrame).
 */
export function stepOutOfFrame(s: ProbeSession, script: string, run: Run): Promise<{ stdout: string; exitCode: number }> {
  return atTopFrame(s, run, () => run(['eval', topFrameScript(script)]))
}

/**
 * Do `work` on the top frame while the agent has a frame selected: step out
 * (`frame main`), work, and select the agent's frame again, holding the
 * session's other commands (`frameStep`, which execBrowser waits for) so
 * none of them runs on the top frame meanwhile. When stepping out fails, its
 * answer stands in for the work's. When the agent's frame cannot be selected
 * again (it went away), the session is left on the top frame and `frame` is
 * cleared — what the CLI does itself when a frame goes.
 */
export async function atTopFrame<T extends { stdout: string; exitCode: number }>(
  s: ProbeSession,
  run: Run,
  work: () => Promise<T>,
): Promise<T | { stdout: string; exitCode: number }> {
  while (s.frameStep) await s.frameStep
  let release = () => {}
  s.frameStep = new Promise<void>((resolve) => { release = resolve })
  try {
    const out = await run(['frame', 'main'])
    if (out.exitCode !== 0) return out
    const read = await work()
    if (s.frame) {
      let back = await run(['frame', s.frame])
      // A snapshot taken inside the frame replaced the CLI's ref table with
      // the frame's own refs (0.44+ replaces it on every snapshot), so the
      // ref the agent selected the frame by is unknown on the page. Refs
      // persist per element: a read of the page brings it back.
      if (back.exitCode !== 0 && /^@?e\d+$/.test(s.frame) && /Unknown ref/.test(back.stdout)) {
        const restored = await run(['snapshot', '-i', '-c'])
        if (restored.exitCode === 0) back = await run(['frame', s.frame])
      }
      if (back.exitCode !== 0) {
        console.log(`[Browser] Could not select the agent's frame again (${s.frame}); the session is on the top frame`)
        s.frame = null
      }
    } else {
      console.log('[Browser] A probe ran inside a frame the harness did not know the agent selected; the session is now on the top frame')
    }
    return read
  } finally {
    s.frameStep = null
    release()
  }
}
