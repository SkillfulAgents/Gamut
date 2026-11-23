import { useState } from 'react'
import type { ApiMessage, ApiToolCall } from '@shared/lib/types/api'
import { useMessages } from '@renderer/hooks/use-messages'
import { useMessageStream } from '@renderer/hooks/use-message-stream'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { classifyUserMessage } from '@renderer/components/messages/user-message-kinds'
import { parseUserMessageParts } from '@shared/lib/utils/user-message-parts'

function messageText(message: ApiMessage) {
  if (message.integration) return message.integration.request?.text ?? message.integration.event.label
  if (message.type === 'user') return parseUserMessageParts(message.content.text).text
  return message.content.text
}

function ToolRecord({ tool }: { tool: ApiToolCall }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <details className="rounded-item border px-2 py-1 text-xs" onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer">{tool.name}</summary>
      {expanded && <>
        <pre className="whitespace-pre-wrap break-words">{JSON.stringify(tool.input, null, 2)}</pre>
        {tool.result != null && <pre className="whitespace-pre-wrap break-words">{typeof tool.result === 'string' ? tool.result : JSON.stringify(tool.result, null, 2)}</pre>}
      </>}
    </details>
  )
}

/** A called session can contain actionable tool cards. Here they are inspectable records. */
export function CalledSessionTranscript({ agentSlug, sessionId }: { agentSlug: string; sessionId: string }) {
  const { data: messages, hasOlder, fetchOlder, isFetchingOlder, isLoading, error } = useMessages(sessionId, agentSlug)
  const { streamingMessage, streamingToolUses } = useMessageStream(sessionId, agentSlug, ['streamingMessage', 'streamingToolUses'])
  const visible = (messages ?? []).filter((message): message is ApiMessage => message.type === 'assistant' || (message.type === 'user' && !classifyUserMessage(message).hidden))
  const last = visible.at(-1)
  const savedToolIds = new Set(last?.toolCalls?.map(tool => tool.id))
  const liveText = streamingMessage && !(last?.type === 'assistant' && last.content.text.includes(streamingMessage)) ? streamingMessage : null
  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 p-4 text-sm" data-testid="called-transcript">
      {isLoading && <p>Loading conversation…</p>}
      {error && <p role="alert">Could not load this conversation.</p>}
      {hasOlder && <button type="button" disabled={isFetchingOlder} onClick={() => void fetchOlder()} className="text-xs underline">Earlier messages</button>}
      {visible.map(message => (
        <div key={message.id} className={message.type === 'user' ? 'ml-6 rounded-card bg-muted px-3 py-2' : 'space-y-2'}>
          <AgentMarkdown
            mode="settled"
            agentSlug={message.integration ? undefined : agentSlug}
            text={messageText(message)}
          />
          {message.toolCalls?.map(tool => <ToolRecord key={tool.id} tool={tool} />)}
        </div>
      ))}
      {liveText && <AgentMarkdown mode="streaming" agentSlug={agentSlug} text={liveText} />}
      {streamingToolUses.filter(tool => !savedToolIds.has(tool.id)).map(tool => <p key={tool.id} className="text-xs text-muted-foreground">{tool.name}…</p>)}
    </div>
  )
}
