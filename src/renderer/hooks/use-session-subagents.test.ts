import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { apiFetch } from '@renderer/lib/api'
import { publishSubagentSnapshot, reconcileSubagents, sessionSubagentOptions } from './use-session-subagents'
import type { SubagentInfo } from './use-message-stream'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
const launch: SubagentInfo = {
  parentToolId: 'launch', agentId: 'a', subagentType: 'Explore', description: 'Review',
  streamingMessage: null, streamingToolUse: null, progressSummary: null, usage: null, lastToolName: null,
}
const snapshot = { isActive: true, activeSubagents: [launch], completedSubagents: null, backgroundTasks: [] }

describe('session subagent inventory', () => {
  it('keeps a launch that arrives during the initial directory read, then joins a resumed run to the same row', async () => {
    const client = new QueryClient()
    let respond!: (value: Response) => void
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise(resolve => { respond = resolve }))
    const options = sessionSubagentOptions('atlas', 'session')
    const pending = client.fetchQuery(options)
    publishSubagentSnapshot(client, 'session', snapshot, false)
    expect(client.getQueryData(options.queryKey)?.entries[0].status).toBe('running')
    respond(Response.json([{ id: 'a', toolUseId: 'launch', finished: true }, { id: 'legacy' }]))
    await pending
    const resumed = { ...launch, parentToolId: 'resume', subagentType: null }
    publishSubagentSnapshot(client, 'session', { ...snapshot, activeSubagents: [launch, resumed], completedSubagents: new Set(['launch']) }, false)
    const data = client.getQueryData(options.queryKey)!
    expect(data.entries).toHaveLength(2)
    expect(data.byId.get('resume')).toBe(data.byId.get('launch'))
    expect(data.byId.get('a')).toMatchObject({ activeSubagent: resumed, status: 'running' })
    publishSubagentSnapshot(client, 'session', { ...snapshot, activeSubagents: [] }, false)
    expect(client.getQueryData(options.queryKey)?.entries.map(row => row.status)).toEqual(['completed', 'unknown'])
  })

  it('waits for the last owned command across reconnect, even after the SDK retires the agent task', () => {
    const files = [{ id: 'a', finished: true }, { id: 'other', finished: true }]
    const sleep = { taskId: 'sleep', startedAt: 1, parentTaskId: 'a' }
    const second = { ...sleep, taskId: 'second' }
    const unrelated = { taskId: 'root', startedAt: 1 }
    const finished = { ...snapshot, completedSubagents: new Set(['launch']) }
    const state = reconcileSubagents(files, { ...finished, backgroundTasks: [sleep, second, unrelated] })
    expect(state.byId.get('a')).toMatchObject({ status: 'running', waitingForChildren: true })
    expect(state.byId.get('other')?.status).toBe('completed')
    const reconnect = { ...finished, activeSubagents: [], backgroundTasks: [second, unrelated] }
    expect(reconcileSubagents(files, reconnect).byId.get('a')).toMatchObject({ status: 'running', waitingForChildren: true })
    expect(reconcileSubagents(files, { ...reconnect, backgroundTasks: [unrelated] }).byId.get('a')?.status).toBe('completed')
  })

  it('honors user stops, ignores workflow runs and keeps background work live after a child turn finishes', () => {
    const state = { ...snapshot, activeSubagents: [launch, { ...launch, agentId: 'workflow', subagentType: null }],
      completedSubagents: new Set(['launch']), backgroundTasks: [{ taskId: 'a', startedAt: 0, isSubagent: true }] }
    expect(reconcileSubagents([{ id: 'stopped', stoppedByUser: true }], state).entries.map(row => [row.id, row.status]))
      .toEqual([['stopped', 'cancelled'], ['a', 'running']])
  })
})
