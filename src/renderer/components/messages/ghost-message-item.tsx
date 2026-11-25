import { memo } from 'react'
import type { ApiMessage } from '@shared/lib/types/api'
import { useRenderTracker } from '@renderer/lib/perf'
import { MessageItem } from './message-item'

interface GhostSender {
  id: string
  name: string
  email: string
  image?: string | null
}

interface GhostMessageItemProps {
  id: string
  text: string
  sentAt: number
  sender?: GhostSender
  integration?: ApiMessage['integration']
  agentSlug: string
}

function sameSender(a: GhostSender | undefined, b: GhostSender | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.id === b.id && a.name === b.name && a.email === b.email && a.image === b.image
}

/**
 * The bubble of a message that is not in the transcript yet (our own pending
 * send, or a peer's). The list re-renders on every streamed chunk of the reply
 * and used to hand MessageItem a new `message` object each time, which defeated
 * its memo: the ghost's whole subtree (markdown, context menu) rendered once per
 * chunk. This row renders again only when what it shows changes. The sender is
 * compared by its fields, not its identity: the list rebuilds a peer ghost's
 * sender on each render.
 */
export const GhostMessageItem = memo(function GhostMessageItem({ id, text, sentAt, sender, integration, agentSlug }: GhostMessageItemProps) {
  useRenderTracker('GhostMessageItem')
  // A new object per render is fine here: the comparison below lets a render
  // through only when one of these fields changed.
  const message: ApiMessage = {
    id,
    type: 'user',
    content: { text },
    toolCalls: [],
    createdAt: new Date(sentAt),
    sender,
    integration,
  }
  return <MessageItem message={message} agentSlug={agentSlug} />
}, (prev, next) =>
  prev.id === next.id &&
  prev.text === next.text &&
  prev.sentAt === next.sentAt &&
  prev.agentSlug === next.agentSlug &&
  prev.integration === next.integration &&
  sameSender(prev.sender, next.sender)
)
