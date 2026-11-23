import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { backgroundCommandId, backgroundToolResultText, labelBackgroundTasks, type BackgroundTaskRef, type LabeledBackgroundTask } from '@renderer/lib/background-task-label'

export interface BackgroundTaskEntry extends LabeledBackgroundTask {
  running: boolean
  /** The latest output the agent read back (TaskOutput), or a monitor's events. */
  output: string | null
  /** How a monitor ended, when it has. */
  endReason: string | null
}

/** Reconcile the commands and monitors in the transcript with the runtime's active task ids. */
export function collectBackgroundTasks(
  messages: ApiMessageOrBoundary[] | undefined,
  live: readonly BackgroundTaskRef[],
) {
  const tasks = new Map<string, BackgroundTaskRef>()
  const outputs = new Map<string, string>()
  const monitors = new Map<string, { events: string[]; endReason: string | null }>()

  for (const message of messages ?? []) {
    if (message.type === 'monitor_event') {
      const { taskId } = message
      const monitor = monitors.get(taskId) ?? { events: [], endReason: null }
      monitor.events.push(...message.events)
      if (message.endReason) monitor.endReason = message.endReason
      monitors.set(taskId, monitor)
      if (!tasks.has(taskId)) {
        tasks.set(taskId, { taskId, startedAt: new Date(message.createdAt).getTime(), taskType: 'monitor_event', description: message.description ?? undefined })
      }
      continue
    }
    if (message.type !== 'assistant' && message.type !== 'user') continue
    for (const call of message.toolCalls ?? []) {
      if (call.isError) continue
      if (call.name === 'Bash' || call.name === 'Monitor') {
        const taskId = call.name === 'Bash' ? backgroundCommandId(call) : call.backgroundTaskId
        if (taskId) tasks.set(taskId, { taskId, startedAt: new Date(message.createdAt).getTime() })
      } else if (call.name === 'TaskOutput' || call.name === 'BashOutput') {
        const taskId = call.name === 'TaskOutput' ? call.input.task_id : call.input.bash_id ?? call.input.shell_id
        const text = backgroundToolResultText(call.result)
        if (typeof taskId === 'string' && text) outputs.set(taskId, text)
      }
    }
  }

  const runningIds = new Set<string>()
  for (const task of live) {
    runningIds.add(task.taskId)
    tasks.set(task.taskId, task)
  }

  const entries = labelBackgroundTasks([...tasks.values()], messages).map((task): BackgroundTaskEntry => {
    const monitor = monitors.get(task.taskId)
    return {
      ...task,
      title: monitor ? 'Monitor' : task.title,
      isMonitor: !!(task.isMonitor || monitor),
      running: runningIds.has(task.taskId),
      output: monitor?.events.join('\n') || outputs.get(task.taskId) || null,
      endReason: monitor?.endReason ?? null,
    }
  })
  const byId = new Map(entries.map(task => [task.taskId, task]))
  return {
    running: live.map(task => byId.get(task.taskId)!),
    commands: entries.filter(task => !task.isSubagent && !task.isWorkflow).sort((a, b) => b.startedAt - a.startedAt),
  }
}
