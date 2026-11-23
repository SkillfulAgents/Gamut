// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createAssistantMessage, createUserMessage } from '@renderer/test/factories'
import { CalledSessionTranscript } from './called-session-transcript'

const note = 'Launch summary'
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: [
    createUserMessage({
      content: { text: 'The model-facing envelope' },
      integration: {
        version: 1,
        integration: { id: 'slack', name: 'Slack', provider: 'slack', family: 'chat' },
        event: { type: 'message', label: 'New message' },
        request: { text: note },
        source: { kind: 'channel', identifier: 'C1' },
      },
    }),
    createAssistantMessage({ content: { text: 'Published' } }),
  ] }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => ({ streamingMessage: null, streamingToolUses: [] }),
}))
vi.mock('@renderer/components/messages/agent-markdown', () => ({
  AgentMarkdown: ({ text, agentSlug }: { text: string; agentSlug?: string }) => <span data-agent={agentSlug}>{text}</span>,
}))

it('renders the integration request text with workspace files disabled and scopes the reply to the called agent', () => {
  render(<CalledSessionTranscript agentSlug="called-agent" sessionId="child" />)
  expect(screen.getByText(note)).not.toHaveAttribute('data-agent')
  expect(screen.queryByText('The model-facing envelope')).toBeNull()
  expect(screen.getByText('Published')).toHaveAttribute('data-agent', 'called-agent')
})
