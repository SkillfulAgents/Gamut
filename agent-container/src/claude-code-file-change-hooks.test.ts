/**
 * The Write/Edit wiring for FileHook.onChange: the file is read before the
 * tool call and handed to the hook with what the call wrote, and a failed call
 * drops what was read. And the Read wiring for FileHook.beforeRead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

type MockQueryCall = { options: Record<string, unknown> }
const calls: MockQueryCall[] = []

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: Record<string, unknown> }) => {
    calls.push({ options: args.options })
    const abortController = args.options.abortController as AbortController
    return {
      [Symbol.asyncIterator]() {
        return this
      },
      next: () =>
        new Promise<IteratorResult<never>>((resolve) => {
          if (abortController.signal.aborted) resolve({ value: undefined, done: true })
          abortController.signal.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true })
        }),
      return: () => Promise.resolve({ value: undefined, done: true }),
      interrupt: () => Promise.resolve(),
    }
  }),
}))

vi.mock('./mcp-server', () => ({
  createUserInputMcpServer: () => ({}),
  createBrowserMcpServer: () => ({}),
  createComputerUseMcpServer: () => ({}),
  createDashboardsMcpServer: () => ({}),
  createWidgetsMcpServer: () => ({}),
  createAgentsMcpServer: () => ({}),
  createChatMcpServer: () => ({}),
  createMeetingsMcpServer: () => ({}),
  createRulesMcpServer: () => ({}),
}))

vi.mock('./tools/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('./tools/computer-use', () => ({ COMPUTER_USE_SERVER: 'agent-desktop', COMPUTER_USE_TOOL_PREFIX: 'mcp__agent-desktop__', computerUseTools: [] }))
vi.mock('./input-manager', () => ({ inputManager: {}, HUMAN_INPUT_TTL_MS: 24 * 60 * 60 * 1000 }))

const changeHook = vi.hoisted(() => ({
  watched: new Set<string>(),
  matches(filePath: string) {
    return this.watched.has(filePath)
  },
  onRead: () => ({}),
  onWrite: () => ({}),
  onEdit: () => ({}),
  onChange: vi.fn((_filePath: string, _before: string | null, _after: string, _context: { sessionId: string }) => ({ warning: 'changed' })),
  beforeRead: vi.fn(async (_filePath: string, _context: { sessionId: string }): Promise<{ error?: string }> => ({})),
}))

vi.mock('./file-hooks', async () => ({
  editedFile: (await vi.importActual<typeof import('./file-hooks/github-conflict-hook')>('./file-hooks/github-conflict-hook')).editedFile,
  fileHooks: [changeHook],
  resolveToolFilePath: (toolInput: Record<string, unknown>) => (toolInput.file_path as string | undefined) ?? null,
  mountIndexCommandHint: () => undefined,
}))

import { ClaudeCodeProcess } from './claude-code'

type HookFn = (input: unknown, toolUseId: string | undefined) => Promise<Record<string, unknown>>
type Matchers = Array<{ matcher?: string; hooks: HookFn[] }>

async function startHooks() {
  const sessionId = `file-change-${calls.length}`
  const process = new ClaudeCodeProcess({ sessionId, workingDirectory: '/tmp' })
  await process.start()
  const hooks = calls[calls.length - 1].options.hooks as Record<string, Matchers>
  const find = (event: string, matcher = 'Write|Edit') => hooks[event].find((m) => m.matcher === matcher)!.hooks[0]
  return { process, sessionId, before: find('PreToolUse'), after: find('PostToolUse'), failed: find('PostToolUseFailure'), read: find('PreToolUse', 'Read') }
}

describe('ClaudeCodeProcess file change hooks', () => {
  let dir: string

  beforeEach(() => {
    calls.length = 0
    changeHook.onChange.mockClear()
    changeHook.beforeRead.mockClear()
    changeHook.watched.clear()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-change-hooks-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('hands the hook the file before and after the call, and returns its warning', async () => {
    const file = path.join(dir, 'AGENTS.md')
    changeHook.watched.add(file)
    fs.writeFileSync(file, 'before')
    const { process, sessionId, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    const result = await after({ tool_name: 'Write', tool_input: { file_path: file, content: 'after' } }, 'tool-1')

    expect(changeHook.onChange).toHaveBeenCalledWith(file, 'before', 'after', { sessionId })
    expect(result).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'changed' } })
    await process.stop()
  })

  it('hands the hook what the call read and wrote, not the file as another session left it', async () => {
    const file = path.join(dir, 'sidebar.json')
    changeHook.watched.add(file)
    fs.writeFileSync(file, 'before')
    const { process, sessionId, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    fs.writeFileSync(file, 'rewritten by another session')
    await after({ tool_name: 'Write', tool_input: { file_path: file, content: 'mine' } }, 'tool-1')
    expect(changeHook.onChange).toHaveBeenLastCalledWith(file, 'before', 'mine', { sessionId })

    await before({ tool_input: { file_path: file } }, 'tool-2')
    const reply = { originalFile: 'one two', oldString: 'two', newString: 'three' }
    await after({ tool_name: 'Edit', tool_input: { file_path: file }, tool_response: reply }, 'tool-2')
    expect(changeHook.onChange).toHaveBeenLastCalledWith(file, 'one two', 'one three', { sessionId })
    await process.stop()
  })

  it('waits on no change for a Write a hook refuses', async () => {
    const file = path.join(dir, 'sidebar.json')
    changeHook.watched.add(file)
    const refuse = vi.spyOn(changeHook, 'onWrite').mockReturnValue({ error: 'bad' } as never)
    const { process, before, after } = await startHooks()

    await before({ tool_input: { file_path: file, content: 'bad' } }, 'tool-1')
    await after({ tool_name: 'Write', tool_input: { file_path: file, content: 'bad' } }, 'tool-1')

    expect(changeHook.onChange).not.toHaveBeenCalled()
    refuse.mockRestore()
    await process.stop()
  })

  it('lets a hook write its file fresh before a Read, for this session', async () => {
    const file = path.join(dir, 'sidebar.json')
    changeHook.watched.add(file)
    const { process, sessionId, read } = await startHooks()

    await read({ tool_input: { file_path: file } }, 'tool-1')
    await read({ tool_input: { file_path: path.join(dir, 'notes.md') } }, 'tool-2')

    expect(changeHook.beforeRead).toHaveBeenCalledTimes(1)
    expect(changeHook.beforeRead).toHaveBeenCalledWith(file, { sessionId })

    // A hook with no file to show refuses the Read with its reason.
    changeHook.beforeRead.mockResolvedValueOnce({ error: 'no sidebar' })
    expect(await read({ tool_input: { file_path: file } }, 'tool-3')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no sidebar' },
    })
    await process.stop()
  })

  it('passes null for a file the call created', async () => {
    const file = path.join(dir, 'AGENTS.md')
    changeHook.watched.add(file)
    const { process, sessionId, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    await after({ tool_name: 'Write', tool_input: { file_path: file, content: 'created' } }, 'tool-1')

    expect(changeHook.onChange).toHaveBeenCalledWith(file, null, 'created', { sessionId })

    // An Edit that created the file has no original to rebuild from, so the file is read back.
    fs.rmSync(file, { force: true })
    await before({ tool_input: { file_path: file } }, 'tool-2')
    fs.writeFileSync(file, 'made by edit')
    await after({ tool_name: 'Edit', tool_input: { file_path: file }, tool_response: { originalFile: '', oldString: '', newString: 'made by edit' } }, 'tool-2')
    expect(changeHook.onChange).toHaveBeenLastCalledWith(file, null, 'made by edit', { sessionId })
    await process.stop()
  })

  it('drops the snapshot of a call that failed', async () => {
    const file = path.join(dir, 'AGENTS.md')
    changeHook.watched.add(file)
    fs.writeFileSync(file, 'before')
    const { process, before, after, failed } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    await failed({ tool_input: { file_path: file } }, 'tool-1')
    await expect(after({ tool_input: { file_path: file } }, 'tool-1')).resolves.toEqual({})

    expect(changeHook.onChange).not.toHaveBeenCalled()
    await process.stop()
  })

  it('leaves files no change hook matches alone', async () => {
    const file = path.join(dir, 'notes.md')
    fs.writeFileSync(file, 'before')
    const { process, sessionId, before, after } = await startHooks()

    await before({ tool_input: { file_path: file } }, 'tool-1')
    fs.writeFileSync(file, 'after')
    await expect(after({ tool_input: { file_path: file } }, 'tool-1')).resolves.toEqual({})

    expect(changeHook.onChange).not.toHaveBeenCalled()
    await process.stop()
  })
})
