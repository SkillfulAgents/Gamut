import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query'
import { subagentRefSchema, type SubagentRef } from '@shared/lib/agent-actor/subagent-metadata'
import { apiFetch } from '@renderer/lib/api'
import type { SubagentInfo } from './use-message-stream'
import type { BackgroundTaskRef } from '@renderer/lib/background-task-label'

interface SubagentSnapshot {
  isActive: boolean
  activeSubagents: SubagentInfo[]
  completedSubagents: Set<string> | null
  backgroundTasks: BackgroundTaskRef[]
}

export interface SessionSubagent {
  id: string
  agentId: string | null
  toolUseId: string | null
  name: string
  description: string
  status: 'running' | 'completed' | 'cancelled' | 'unknown'
  activeSubagent: SubagentInfo | null
  backgroundRunning: boolean
  waitingForChildren: boolean
  isCompleted: boolean
}

interface SubagentCollection {
  files: SubagentRef[]
  filesLoaded: boolean
  snapshot?: SubagentSnapshot
  entries: SessionSubagent[]
  byId: Map<string, SessionSubagent>
}

export function reconcileSubagents(files: SubagentRef[], snapshot?: SubagentSnapshot, previous?: SubagentCollection): SubagentCollection {
  const groups = new Map<string, { file?: SubagentRef; runs: SubagentInfo[] }>()
  const launchIds = new Map<string, string>()
  for (const file of files) {
    groups.set(file.id, { file, runs: [] })
    if (file.toolUseId) launchIds.set(file.toolUseId, file.id)
  }
  const background = new Map(snapshot?.backgroundTasks.filter(task => task.isSubagent).map(task => [task.taskId, task]))
  // The SDK can retire the agent's own task while a command it launched is still live.
  const parentsWithLiveChildren = new Set<string>()
  for (const task of snapshot?.backgroundTasks ?? []) {
    if (!task.parentTaskId) continue
    parentsWithLiveChildren.add(task.parentTaskId)
    // A reconnect can supply only the command, before its known owner's first file is visible.
    if (!groups.has(task.parentTaskId) && previous?.byId.get(task.parentTaskId)?.agentId === task.parentTaskId) {
      groups.set(task.parentTaskId, { runs: [] })
    }
  }
  for (const run of snapshot?.activeSubagents ?? []) {
    const agentId = run.agentId ?? (run.parentToolId && launchIds.get(run.parentToolId))
    const id = agentId || run.parentToolId
    if (!id || (!run.subagentType && !groups.has(id) && !background.has(id) && !previous?.byId.has(id))) continue
    const group = groups.get(id) ?? { runs: [] }
    group.runs.push(run)
    groups.set(id, group)
  }
  for (const id of background.keys()) {
    if (!groups.has(id)) groups.set(id, { runs: [] })
  }

  const entries: SessionSubagent[] = []
  const byId = new Map<string, SessionSubagent>()
  const ended = (run: SubagentInfo) => run.status === 'completed' || !!(run.parentToolId && snapshot?.completedSubagents?.has(run.parentToolId))
  for (const [id, { file, runs }] of groups) {
    const run = runs.findLast(item => !ended(item)) ?? runs.at(-1) ?? null
    const prior = previous?.byId.get(id) ?? (run?.parentToolId ? previous?.byId.get(run.parentToolId) : undefined)
    const task = background.get(id)
    const isCompleted = !!run && ended(run)
    const turnRunning = !!run && !!snapshot?.isActive && !isCompleted
    const waitingForChildren = parentsWithLiveChildren.has(id) && !task && !turnRunning
    let status: SessionSubagent['status'] = 'unknown'
    if (task || turnRunning || waitingForChildren) status = 'running'
    else if (file?.stoppedByUser) status = 'cancelled'
    else if (isCompleted || file?.finished || prior?.status === 'completed') status = 'completed'
    const entry: SessionSubagent = {
      id, agentId: file?.id ?? run?.agentId ?? task?.taskId ?? prior?.agentId ?? null,
      toolUseId: file?.toolUseId ?? prior?.toolUseId ?? runs[0]?.parentToolId ?? null,
      name: run?.subagentType || file?.agentType || task?.subagentType || prior?.name || 'Agent',
      description: run?.description || file?.description || task?.description || prior?.description || '',
      status, activeSubagent: run, backgroundRunning: !!task, waitingForChildren, isCompleted,
    }
    entries.push(entry)
    byId.set(id, entry)
    if (entry.toolUseId) byId.set(entry.toolUseId, entry)
    for (const item of runs) if (item.parentToolId) byId.set(item.parentToolId, entry)
  }
  return { files, filesLoaded: previous?.filesLoaded ?? !snapshot, snapshot, entries, byId }
}

// The session stream is keyed by its UUID. The same session may be opened by agent ID or slug.
const subagentKey = (sessionId: string | null) => ['session-subagents', sessionId] as const

export function sessionSubagentOptions(agentSlug: string, sessionId: string | null) {
  return queryOptions<SubagentCollection>({
    queryKey: subagentKey(sessionId),
    enabled: !!sessionId && !!agentSlug,
    staleTime: query => query.state.data?.filesLoaded ? 60_000 : 0,
    queryFn: async ({ signal }) => {
      const response = await apiFetch(`/api/agents/${agentSlug}/sessions/${sessionId}/subagents`, { signal })
      if (!response.ok) throw new Error('Could not load subagents')
      return reconcileSubagents(subagentRefSchema.array().parse(await response.json()))
    },
    // A directory read can finish after a launch, resume, or reconnect. Join the files
    // with the latest runtime snapshot at the point TanStack commits the response.
    structuralSharing: (oldValue: unknown, newValue: unknown) => {
      const incoming = newValue as SubagentCollection
      const current = oldValue as SubagentCollection | undefined
      return !incoming.snapshot && current?.snapshot
        ? { ...reconcileSubagents(incoming.files, current.snapshot, current), filesLoaded: true }
        : incoming
    },
  })
}

export function useSessionSubagents(agentSlug: string, sessionId: string | null) {
  return useQuery(sessionSubagentOptions(agentSlug, sessionId))
}

export function publishSubagentSnapshot(client: QueryClient, sessionId: string, state: SubagentSnapshot, refreshFiles: boolean) {
  const key = subagentKey(sessionId)
  const { isActive, activeSubagents, completedSubagents, backgroundTasks } = state
  client.setQueryData<SubagentCollection>(key, old =>
    reconcileSubagents(old?.files ?? [], { isActive, activeSubagents, completedSubagents, backgroundTasks }, old))
  if (refreshFiles) void client.invalidateQueries({ queryKey: key })
}
