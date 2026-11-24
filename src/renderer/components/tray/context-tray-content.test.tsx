// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ContextBreakdown } from '@shared/lib/container/context-breakdown-schema'

const state = {
  breakdown: null as ContextBreakdown | null,
  isActive: false,
  liveUsage: undefined as { totalTokens: number; contextWindow: number } | undefined,
  refetch: vi.fn(),
  send: vi.fn(),
  canUse: true,
  usage: undefined as { totalTokens: number; contextWindow: number } | undefined,
}
vi.mock('@renderer/hooks/use-sessions', () => ({ useSession: () => ({ data: { lastUsage: state.usage } }) }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ canUseAgent: () => state.canUse }) }))
vi.mock('@renderer/hooks/use-context-breakdown', () => ({
  useContextBreakdown: () => ({ data: { breakdown: state.breakdown }, isLoading: false, isError: false, isFetching: false, refresh: state.refetch }),
}))
vi.mock('@renderer/hooks/use-message-stream', () => ({ useMessageStream: () => ({ isActive: state.isActive, contextUsage: state.liveUsage }) }))
vi.mock('@renderer/hooks/use-messages', () => ({ useSendMessage: () => ({ mutate: state.send, isPending: false }) }))

import { ContextTrayContent, formatTokens } from './context-tray-content'

const BREAKDOWN: ContextBreakdown = {
  categories: [
    { id: 'messages', name: 'Messages', tokens: 431_100, kind: 'used' },
    { id: 'mcp_tools', name: 'MCP tools', tokens: 27_800, kind: 'used' },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 454_600, kind: 'free' },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 481_800, kind: 'deferred' },
  ],
  totalTokens: 512_400,
  rawMaxTokens: 1_000_000,
  percentage: 51,
  memoryFiles: [{ path: '/workspace/CLAUDE.md', tokens: 11_000 }],
  mcpTools: [{ name: 'mcp__browser__navigate', serverName: 'browser', tokens: 900 }],
  autoCompactThreshold: 962_400,
  isAutoCompactEnabled: true,
}

describe('formatTokens', () => {
  it('writes counts the way /context does', () => {
    expect(formatTokens(512_400)).toBe('512.4K')
    expect(formatTokens(33_000)).toBe('33K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(640)).toBe('640')
  })
})

describe('ContextTrayContent', () => {
  beforeEach(() => {
    state.usage = undefined
    state.liveUsage = undefined
    state.canUse = true
    state.breakdown = BREAKDOWN
    state.isActive = false
    state.refetch.mockClear()
    state.send.mockClear()
  })

  it('shows how full the window is, row by row, with deferred rows outside it', () => {
    render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    expect(screen.getByTestId('context-percent')).toHaveTextContent('51% used')
    expect(screen.getByText('512.4K / 1M')).toBeInTheDocument()
    const rows = screen.getAllByTestId('context-row')
    expect(rows.map(row => row.getAttribute('data-kind'))).toEqual(['used', 'used', 'buffer', 'free', 'deferred'])
    expect(rows[0]).toHaveTextContent('Messages431.1K43.1%')
    expect(rows[4]).toHaveTextContent('—')
    expect(screen.getByTestId('context-until-compact')).toHaveTextContent('450K until auto-compact')
  })

  it('opens the MCP tools and memory files behind their rows', async () => {
    const user = userEvent.setup()
    render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    await user.click(screen.getByRole('button', { name: /Memory files/ }))
    expect(screen.getByText('/workspace/CLAUDE.md')).toBeInTheDocument()
  })

  it('compacts the session between turns, not during one', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    await user.click(screen.getByTestId('context-compact'))
    expect(state.send).toHaveBeenCalledWith({ sessionId: 's', agentSlug: 'a', content: '/compact' })

    state.isActive = true
    rerender(<ContextTrayContent agentSlug="a" sessionId="s" />)
    expect(screen.getByTestId('context-compact')).toBeDisabled()
  })

  it('hides counts and compaction for a read-only member', () => {
    state.canUse = false
    state.usage = { totalTokens: 48_616, contextWindow: 1_000_000 }
    render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    expect(screen.getByText(/requires permission/)).toBeVisible()
    expect(screen.getByTestId('context-percent')).toHaveTextContent('5% used')
    expect(screen.queryByRole('button', { name: /Memory files/ })).toBeNull()
    expect(screen.queryByTestId('context-compact')).toBeNull()
  })

  it('shows the current first-turn usage before any measurement is saved', () => {
    state.isActive = true
    state.breakdown = null
    state.liveUsage = { totalTokens: 73_000, contextWindow: 200_000 }
    render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    expect(screen.getByText('73K / 200K')).toBeVisible()
    expect(screen.getByTestId('context-unavailable')).toHaveTextContent('Live usage')
  })

  it('shows the token count alone when an older image omitted the window', () => {
    state.breakdown = null
    state.usage = { totalTokens: 5_100, contextWindow: 0 }
    render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    expect(screen.getByText('5.1K tokens')).toBeVisible()
    expect(screen.getByTestId('context-percent')).toHaveTextContent('Context usage')
  })

  it('says when there is no live runtime to ask', () => {
    state.breakdown = null
    render(<ContextTrayContent agentSlug="a" sessionId="s" />)
    expect(screen.getByTestId('context-unavailable')).toBeInTheDocument()
  })
})
