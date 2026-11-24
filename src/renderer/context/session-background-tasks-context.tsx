import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { useMessages } from '@renderer/hooks/use-messages'
import { collectBackgroundTasks } from '@renderer/components/tray/background-tasks'

type TaskCollection = ReturnType<typeof collectBackgroundTasks> & Pick<ReturnType<typeof useMessages>,
  'hasOlder' | 'fetchOlder' | 'isFetchingOlder' | 'isLoading' | 'isError'>
const BackgroundTasksContext = createContext<TaskCollection | null>(null)
export const useSessionBackgroundTasks = () => useContext(BackgroundTasksContext)

export function SessionBackgroundTasksProvider({ sessionId, agentSlug, children }: {
  sessionId: string | null; agentSlug: string; children: ReactNode
}) {
  const { data: messages, hasOlder, fetchOlder, isFetchingOlder, isLoading, isError } = useMessages(sessionId, agentSlug)
  const { backgroundTasks } = useMessageStream(sessionId, agentSlug, ['backgroundTasks'])
  const tasks = useMemo(() => collectBackgroundTasks(messages, backgroundTasks ?? []), [messages, backgroundTasks])
  const taskCollection = useMemo(() => ({ ...tasks, hasOlder, fetchOlder, isFetchingOlder, isLoading, isError }),
    [tasks, hasOlder, fetchOlder, isFetchingOlder, isLoading, isError])
  return <BackgroundTasksContext.Provider value={taskCollection}>{children}</BackgroundTasksContext.Provider>
}
