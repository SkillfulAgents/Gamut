import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { mountedDrives, oversizedFiles } from './volume-mounts'

const WRITING_TOOLS = '^(Bash|Write|Edit|NotebookEdit|Task|Agent)$'

/**
 * On a tool call that can write, names each file a drive keeps local for size that was written since the last check.
 * A subagent's or background job's writes are named on the next main-thread result.
 */
export function syncLimitHooks(): { UserPromptSubmit: HookCallbackMatcher[]; PostToolUse: HookCallbackMatcher[] } {
  if (!mountedDrives().some((drive) => drive.syncLimit)) return { UserPromptSubmit: [], PostToolUse: [] }
  // By size: a read through the mount touches a cached copy's times, never its size. Null until a scan succeeds, and
  // the first success only records: files already there belong to earlier sessions.
  let seen: Map<string, number> | null = null
  const scan = async () => {
    const files = await oversizedFiles()
    if (!files) return []
    const written = seen ? [...files].filter(([file, { size }]) => seen?.get(file) !== size) : []
    seen = new Map([...files].map(([file, { size }]) => [file, size]))
    return written
  }
  // One at a time, so a slower, older scan never replaces a newer record.
  let last: Promise<Awaited<ReturnType<typeof scan>>> = Promise.resolve([])
  const look = () => (last = last.then(scan))
  return {
    // The session's first turn records the cache before its first tool runs. A prewarmed process predates it.
    UserPromptSubmit: [{ hooks: [async () => { if (!seen) await look(); return {} }] }],
    PostToolUse: [{
      matcher: WRITING_TOOLS,
      hooks: [async (input) => {
        if (input.agent_id) return {}
        const written = await look()
        if (written.length === 0) return {}
        return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: written.map(([file, { note }]) => `${JSON.stringify(file)} ${note}`).join('\n') } }
      }],
    }],
  }
}
