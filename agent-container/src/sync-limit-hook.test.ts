import { beforeEach, expect, it, vi } from 'vitest'

const mounts = vi.hoisted(() => ({ mountedDrives: vi.fn(), oversizedFiles: vi.fn() }))
vi.mock('./volume-mounts', () => mounts)
const { syncLimitHooks } = await import('./sync-limit-hook')

const signal = new AbortController().signal
type Hooks = ReturnType<typeof syncLimitHooks>
const afterTool = (hooks: Hooks, extra: object = {}) =>
  hooks.PostToolUse[0].hooks[0]({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {}, tool_response: '', ...extra } as never, 'tool', { signal })
const turnStarts = (hooks: Hooks) => hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' } as never, undefined, { signal })
const cached = (files: Record<string, number>) => new Map(Object.entries(files).map(([file, size]) => [file, { size, note: 'stays local.' }]))

beforeEach(() => {
  vi.resetAllMocks()
  mounts.mountedDrives.mockReturnValue([{ name: 'repo', path: '/mounts/repo', readOnly: false, syncLimit: { bytes: 700_000, note: 'stays local.' } }])
})

it('adds no hooks without a drive that has a sync limit', () => {
  mounts.mountedDrives.mockReturnValue([{ name: 'drive', path: '/mounts/drive', readOnly: false }])
  expect(syncLimitHooks()).toEqual({ UserPromptSubmit: [], PostToolUse: [] })
})

it('names a file written during the turn once, again only after another write, and never on a subagent result', async () => {
  const hooks = syncLimitHooks()
  mounts.oversizedFiles.mockResolvedValue(cached({ '/mounts/repo/old.bin': 900 }))
  await turnStarts(hooks)
  mounts.oversizedFiles.mockResolvedValue(cached({ '/mounts/repo/old.bin': 900, '/mounts/repo/big.png': 800 }))
  expect(await afterTool(hooks, { agent_id: 'sub-1' })).toEqual({})
  expect(await afterTool(hooks)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '"/mounts/repo/big.png" stays local.' } })
  expect(await afterTool(hooks)).toEqual({})
  mounts.oversizedFiles.mockResolvedValue(cached({ '/mounts/repo/old.bin': 900, '/mounts/repo/big.png': 950 }))
  expect(await afterTool(hooks)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '"/mounts/repo/big.png" stays local.' } })
})

it('keeps what it saw through a failed scan, and names files already there only after a first scan records them', async () => {
  const hooks = syncLimitHooks()
  mounts.oversizedFiles.mockResolvedValueOnce(null)
  await turnStarts(hooks)
  mounts.oversizedFiles.mockResolvedValue(cached({ '/mounts/repo/old.bin': 900 }))
  expect(await afterTool(hooks)).toEqual({})
  mounts.oversizedFiles.mockResolvedValueOnce(null)
  expect(await afterTool(hooks)).toEqual({})
  mounts.oversizedFiles.mockResolvedValue(cached({ '/mounts/repo/old.bin': 900, '/mounts/repo/big.png': 800 }))
  expect(await afterTool(hooks)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: '"/mounts/repo/big.png" stays local.' } })
})

it('names a write that lands between turns on the next turn, and once across a parallel batch', async () => {
  const hooks = syncLimitHooks()
  mounts.oversizedFiles.mockResolvedValue(cached({}))
  await turnStarts(hooks)
  mounts.oversizedFiles.mockResolvedValue(cached({ '/mounts/repo/late.bin': 800 }))
  await turnStarts(hooks)
  let finish = (_files: unknown) => {}
  mounts.oversizedFiles.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  const first = afterTool(hooks)
  const second = afterTool(hooks)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(mounts.oversizedFiles).toHaveBeenCalledTimes(2)
  finish(cached({ '/mounts/repo/late.bin': 800 }))
  const results = await Promise.all([first, second])
  expect(results.filter((result) => 'hookSpecificOutput' in result)).toHaveLength(1)
  expect(mounts.oversizedFiles).toHaveBeenCalledTimes(3)
})
