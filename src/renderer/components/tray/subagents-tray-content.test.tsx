// @vitest-environment jsdom
// The Subagents tab: one list of the session's subagents, working ones first,
// that shows one subagent's transcript in place and goes back.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createAssistantMessage, createToolCall } from '@renderer/test/factories'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SubagentRef } from '@shared/lib/agent-actor/subagent-metadata'
import { reconcileSubagents, sessionSubagentOptions } from '@renderer/hooks/use-session-subagents'
import type { SubagentInfo } from '@renderer/hooks/use-message-stream'

const viewSubagent = vi.fn()
let target: string | null
let files: SubagentRef[]
let client: QueryClient
let stream: { activeSubagents: SubagentInfo[]; completedSubagents: Set<string> | null; isActive: boolean }

let messages: unknown[] | undefined
vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => ({ data: messages }),
  useSubagentMessages: () => ({ data: [] }),
}))

import { SubAgentBlock } from '@renderer/components/messages/subagent-block'
import { SubagentsTrayContent } from './subagents-tray-content'

const scan = createToolCall({ id: 'scan', name: 'Agent', input: { subagent_type: 'Explore', description: 'Scan the repo' }, result: undefined })
const oldRun = createToolCall({
  id: 'history', name: 'Agent', input: { subagent_type: 'Explore', description: 'Read the history' },
  result: 'Found the commit', subagent: { agentId: 'sub-history', status: 'completed', totalDurationMs: 21000 },
})
const card = createToolCall({
  id: 'card', name: 'Task', input: { subagent_type: 'general-purpose', description: 'Check the card' },
  result: 'Could not open it', isError: true, subagent: { agentId: 'sub-card', status: 'completed', totalDurationMs: 4000 },
})
const working: SubagentInfo = {
  parentToolId: 'scan', agentId: 'sub-scan', streamingMessage: null, streamingToolUse: null, progressSummary: null,
  subagentType: 'Explore', description: 'Scan the repo',
  usage: { duration_ms: 6000, total_tokens: 900, tool_uses: 2 }, lastToolName: 'Grep',
}

function seedQuery() {
  const collection = reconcileSubagents(files, { ...stream, backgroundTasks: [] })
  client.setQueryData(sessionSubagentOptions('agent-1', 's-1').queryKey, { ...collection, filesLoaded: true })
}

function renderTab() {
  seedQuery()
  return render(<SubagentsTrayContent agentSlug="agent-1" sessionId="s-1" target={target} openDetail={viewSubagent} />, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}

describe('SubagentsTrayContent', () => {
  beforeEach(() => {
    viewSubagent.mockClear()
    target = null
    client = new QueryClient()
    files = [
      { id: 'sub-history', toolUseId: 'history', description: 'Read the history', finished: true },
      { id: 'sub-card', toolUseId: 'card', description: 'Check the card', stoppedByUser: true },
    ]
    stream = { activeSubagents: [working], completedSubagents: null, isActive: true }
    messages = [
      createAssistantMessage({ toolCalls: [oldRun, createToolCall({ id: 'bash', name: 'Bash', result: 'ok' })] }),
      createAssistantMessage({ toolCalls: [card, scan] }),
    ]
  })

  it('shows the same resumed run as working in the original tool row and the tray', () => {
    messages = [createAssistantMessage({ toolCalls: [oldRun] })]
    stream.activeSubagents = [{ ...working, agentId: 'sub-history', parentToolId: 'resume' }]
    stream.completedSubagents = new Set([oldRun.id])
    seedQuery()
    render(
      <QueryClientProvider client={client}>
        <SubAgentBlock toolCall={oldRun} agentSlug="agent-1" sessionId="s-1" />
        <SubagentsTrayContent agentSlug="agent-1" sessionId="s-1" target={null} openDetail={viewSubagent} />
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('subagent-row')).toHaveAttribute('data-status', 'running')
    expect(within(screen.getByTestId('subagents-active')).getByTestId('subagents-list-row')).toHaveAttribute('data-status', 'running')
  })

  it('lists every subagent of the session, with separate working and finished groups', () => {
    renderTab()

    const active = within(screen.getByTestId('subagents-active'))
    expect(active.getByText('Active · 1')).toBeInTheDocument()
    const row = active.getByTestId('subagents-list-row')
    expect(row).toHaveTextContent('Scan the repo')
    // What it is on now, and how long it has been going.
    expect(row).toHaveTextContent('Working · Grep')
    expect(row).toHaveTextContent('6s')

    const done = within(screen.getByTestId('subagents-done'))
    expect(done.getByText('Done · 2')).toBeInTheDocument()
    const finished = done.getAllByTestId('subagents-list-row')
    expect(finished.map(r => r.getAttribute('data-status'))).toEqual(['completed', 'cancelled'])
    expect(finished[0]).toHaveTextContent('Read the history')
    expect(finished[1]).toHaveTextContent('Check the card')
    expect(finished[1]).toHaveTextContent('Stopped')
    // Other tool calls are not subagents.
    expect(screen.getAllByTestId('subagents-list-row')).toHaveLength(3)
  })

  it('shows one subagent\'s transcript in place of the list, and goes back', async () => {
    const user = userEvent.setup()
    const view = renderTab()
    await user.click(screen.getByText('Read the history'))
    expect(viewSubagent).toHaveBeenCalledWith('sub-history')

    target = 'sub-history'
    view.rerender(<SubagentsTrayContent agentSlug="agent-1" sessionId="s-1" target={target} openDetail={viewSubagent} />)
    expect(screen.getByTestId('subagent-transcript')).toHaveTextContent('Found the commit')
    expect(screen.queryByTestId('subagents-list')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'All subagents' }))
    expect(viewSubagent).toHaveBeenLastCalledWith(null)
  })

  it('opens a subagent found only in the full session history', () => {
    files = [{ id: 'fresh', description: 'Archived investigation' }]
    messages = []
    target = 'fresh'
    renderTab()
    expect(screen.getByTestId('subagent-transcript')).toHaveTextContent('Archived investigation')
  })

  it('says so when the session has launched no subagents', () => {
    messages = []
    files = []
    stream = { activeSubagents: [], completedSubagents: null, isActive: false }
    renderTab()
    expect(screen.getByText('No subagents in this session yet.')).toBeInTheDocument()
  })
})
