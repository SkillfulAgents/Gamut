import { Bot } from 'lucide-react'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import { AgentAvatar } from './agent-avatar/agent-avatar'

export type CalledSessionState = 'idle' | 'working' | 'needs-input'
export const calledStateLabel = { idle: 'Idle', working: 'Working', 'needs-input': 'Waiting for input' }

export function calledSessionState(session?: Pick<ApiSession, 'isActive' | 'isAwaitingInput'>, pending = false): CalledSessionState {
  if (session?.isAwaitingInput) return 'needs-input'
  return (session ? session.isActive : pending) ? 'working' : 'idle'
}

export function CalledAgentAvatar({ agent, state, size }: {
  agent?: Pick<ApiAgent, 'slug' | 'avatar'> | null; state: CalledSessionState; size: number
}) {
  return (
    <span className="inline-flex shrink-0" role="img" aria-label={calledStateLabel[state]} data-called-state={state}>
      {agent?.avatar
        ? <AgentAvatar agent={agent} size={size} state={state} still={state === 'idle'} />
        : <Bot aria-hidden className="text-muted-foreground" style={{ width: size, height: size }} />}
    </span>
  )
}
