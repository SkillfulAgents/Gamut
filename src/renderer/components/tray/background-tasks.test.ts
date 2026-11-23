import { describe, expect, it } from 'vitest'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { collectBackgroundTasks } from './background-tasks'

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 10, minute)).toISOString()

function turn(minute: number, ...toolCalls: object[]): ApiMessageOrBoundary {
  return { type: 'assistant', id: `m${minute}`, content: { text: '' }, toolCalls, createdAt: at(minute) } as unknown as ApiMessageOrBoundary
}

describe('collectBackgroundTasks', () => {
  it('lists background commands and monitors, running from the runtime, with the output the agent read', () => {
    const { commands: tasks, running } = collectBackgroundTasks([
      turn(1, { id: 'a', name: 'Bash', input: { command: 'npm test' }, backgroundTaskId: 'bg1' }),
      turn(2, { id: 'b', name: 'Monitor', input: { description: 'watch the log' }, backgroundTaskId: 'mon1' }),
      turn(3, { id: 'c', name: 'TaskOutput', input: { task_id: 'bg1' }, result: 'tests passed' }),
      { type: 'monitor_event', id: 'e', taskId: 'mon1', description: null, events: ['line one'], status: null, endReason: null, createdAt: at(4) } as unknown as ApiMessageOrBoundary,
      turn(5, { id: 'd', name: 'Bash', input: { command: 'ls' } }),
    ], [{ taskId: 'mon1', startedAt: Date.parse(at(2)) }])

    expect(running[0]).toBe(tasks[0])
    expect(tasks.map(t => [t.taskId, t.isMonitor ? 'monitor' : 'command', t.running])).toEqual([['mon1', 'monitor', true], ['bg1', 'command', false]])
    expect(tasks.find(t => t.taskId === 'bg1')?.output).toBe('tests passed')
    expect(tasks.find(t => t.taskId === 'mon1')?.output).toBe('line one')
  })

  it('leaves background subagents and workflows to their own tabs, and adds tasks the transcript has not caught up with', () => {
    const { commands: tasks, running } = collectBackgroundTasks([], [
      { taskId: 'agent1', startedAt: 1, isSubagent: true },
      { taskId: 'wf1', startedAt: 2, isWorkflow: true },
      { taskId: 'bg9', startedAt: 3, description: 'sleep 60' },
    ])
    expect(running.map(task => task.taskId)).toEqual(['agent1', 'wf1', 'bg9'])
    expect(running[2]).toBe(tasks[0])
    expect(tasks.map(t => [t.taskId, t.running, t.detail])).toEqual([['bg9', true, 'sleep 60']])
  })
  it('recognizes the launch id in legacy Bash results and preserves output from a live task outside the loaded page', () => {
    const { commands: tasks } = collectBackgroundTasks([
      turn(1, { id: 'a', name: 'Bash', input: { command: 'ls' }, result: 'Command running in background with ID: old-1.' }),
      turn(2, { id: 'b', name: 'BashOutput', input: { bash_id: 'job' }, result: [{ type: 'text', text: 'ready' }] }),
    ], [{ taskId: 'job', startedAt: 10, description: 'npm test' }])

    expect(tasks.find(t => t.taskId === 'old-1')).toMatchObject({ detail: 'ls', running: false })
    expect(tasks.find(t => t.taskId === 'job')).toMatchObject({ output: 'ready', running: true })
  })

})
