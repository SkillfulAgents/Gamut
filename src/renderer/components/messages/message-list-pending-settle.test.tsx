// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import { useState } from 'react'
import { MessageList } from './message-list'
import { useDraftText } from '@renderer/context/drafts-context'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createUserMessage, createAssistantMessage } from '@renderer/test/factories'
import type { ProviderErrorPresentation } from '@shared/lib/llm-provider/error-presentation'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import type { IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'

// Mock useMessages
const mockFetchOlder = vi.fn()
const mockMessagesData: {
  data: ApiMessageOrBoundary[] | undefined
  isLoading: boolean
  error: Error | null
  fetchOlder: typeof mockFetchOlder
  hasOlder: boolean
  isFetchingOlder: boolean
  dataUpdatedAt: number
} = {
  data: undefined,
  isLoading: false,
  error: null,
  fetchOlder: mockFetchOlder,
  hasOlder: false,
  isFetchingOlder: false,
  dataUpdatedAt: 0,
}

const mockDeleteMessage = vi.fn()
const mockDeleteToolCall = vi.fn()
// Cancel mutation mock: invokes the mutate() callbacks synchronously with a
// configurable result so tests can exercise both race outcomes.
let mockCancelResult: { cancelled: boolean } = { cancelled: true }
const mockCancelQueued = vi.fn(async (_vars: unknown) => mockCancelResult)

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
  useDeleteMessage: () => ({ mutate: mockDeleteMessage }),
  useDeleteToolCall: () => ({ mutate: mockDeleteToolCall }),
  useCancelQueuedMessage: () => ({ mutateAsync: mockCancelQueued }),
  // Real class so `error instanceof TranscriptNotFoundError` works in the component.
  TranscriptNotFoundError: class TranscriptNotFoundError extends Error {
    constructor() {
      super('Session transcript not found')
      this.name = 'TranscriptNotFoundError'
    }
  },
}))

// Mock useMessageStream
const mockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null as string | null,
  streamingToolUses: [] as Array<{ id: string; name: string; partialInput: string }>,
  isCompacting: false,
  activeSubagents: [] as any[],
  completedSubagents: null as Set<string> | null,
  typingUser: null as { id: string; name?: string } | null,
  peerUserMessages: [] as Array<{ uuid: string; receivedAt: number; content: string; sender?: { id: string; name?: string; email?: string }; queued?: boolean; integration?: IntegrationMessageDisplay }>,
  discardedCommandUuids: [] as string[],
  sendReceipts: {} as Record<string, 'picked_up' | 'never_ran'>,
  thinkingBlocks: [] as Array<{ id: number; persistedId?: string; text: string; startedAt: number; endedAt: number | null }>,
  error: null as string | null,
  apiErrorCode: null as string | null,
  errorPresentation: null as ProviderErrorPresentation | null,
}

const mockClearCompacting = vi.fn()
const mockRemovePeerUserMessage = vi.fn()
const mockClearPeerUserMessages = vi.fn()
const mockConsumeDiscardedCommand = vi.fn()
const mockConsumeThinkingBlocks = vi.fn((_sessionId: string, ids: number[]) => {
  mockStreamState.thinkingBlocks = mockStreamState.thinkingBlocks.filter(block => !ids.includes(block.id))
})

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  clearCompacting: (...args: unknown[]) => mockClearCompacting(...args),
  removePeerUserMessage: (...args: unknown[]) => mockRemovePeerUserMessage(...args),
  clearPeerUserMessages: (...args: unknown[]) => mockClearPeerUserMessages(...args),
  consumeDiscardedCommand: (...args: unknown[]) => mockConsumeDiscardedCommand(...args),
  consumeThinkingBlocks: (sessionId: string, ids: number[]) => mockConsumeThinkingBlocks(sessionId, ids),
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: false, platformBaseUrl: null, orgId: null } }),
}))

// Mock useUser — default no user, override per test
let mockCurrentUser: { id: string; name: string; email: string } | null = null
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    user: mockCurrentUser,
    isAuthMode: !!mockCurrentUser,
    isAuthenticated: !!mockCurrentUser,
    isAdmin: false,
    isPending: false,
    mustChangePassword: false,
    rolesReady: true,
    canAccessAgent: () => true,
    canUseAgent: () => true,
    canAdminAgent: () => false,
    agentRole: () => null,
    agentMemberCount: () => 0,
    signOut: async () => {},
  }),
  UserProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock useIsOnline — default online, override per test
let mockIsOnline = true
vi.mock('@renderer/context/connectivity-context', () => ({
  useIsOnline: () => mockIsOnline,
  ConnectivityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock formatElapsed
vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
  useElapsedTimer: () => null,
}))

// Mock getApiBaseUrl
vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://test-api',
  isElectron: () => false,
  getPlatform: () => 'web',
}))

// Names of tool rows rendered, to check which rows re-render.
const mockToolRenders: string[] = []

// Mock child components that are complex
vi.mock('./tool-call-item', () => ({
  ToolCallItem: ({ toolCall, isSessionActive }: any) => (
    mockToolRenders.push(toolCall.name),
    <div data-testid={`tool-call-${toolCall.name}`} data-running={isSessionActive ? 'true' : 'false'}>{toolCall.name}</div>
  ),
  StreamingToolCallItem: ({ name }: any) => <div data-testid="streaming-tool-call">{name}</div>,
  StatusIndicator: ({ status }: any) => <span data-testid="status-indicator">{status}</span>,
}))

vi.mock('./subagent-block', () => ({
  SubAgentBlock: ({ toolCall }: any) => (
    mockToolRenders.push(toolCall.name),
    <div data-testid="subagent-block">{toolCall.name}</div>
  ),
}))

vi.mock('./informational-item', () => ({
  InformationalItem: ({ item }: any) => (
    <div data-testid="informational-item">{item.content}</div>
  ),
}))

// The line's own copy and link are covered in fork-boundary.test.tsx; here only
// its placement in the list matters.
vi.mock('./fork-boundary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fork-boundary')>()),
  ForkBoundaryItem: () => <div data-testid="fork-boundary" />,
}))

vi.mock('./message-context-menu', () => ({
  MessageContextMenu: ({ children }: any) => <>{children}</>,
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))


// A pending bubble outlives the MessageList that could clear it (a session
// switch unmounts the list, the shell keeps the bubble). The owner below
// stands in for AgentShell's per-agent store: it drops a bubble only when the
// list reports it through onPendingMessageAppeared.
function makeOwner(initial: Array<{ localId: string; uuid?: string; text: string; sentAt: number; queued?: boolean }>) {
  const appeared: string[] = []
  let current = initial
  function Owner({ view }: { view: 'S' | 'other' }) {
    const [pending, setPending] = useState(initial)
    current = pending
    const DraftProbe = () => {
      const [draft] = useDraftText('session:S')
      return <div data-testid="draft-probe">{draft ?? ''}</div>
    }
    return (
      <>
        {view === 'S' ? (
          <MessageList
            key="S"
            sessionId="S"
            agentSlug="agent-1"
            pendingUserMessages={pending}
            onPendingMessageAppeared={(localId) => {
              appeared.push(localId)
              setPending((cur) => cur.filter((p) => p.localId !== localId))
            }}
          />
        ) : (
          <div>other session</div>
        )}
        <DraftProbe />
      </>
    )
  }
  return { Owner, appeared, pending: () => current }
}

describe('pending bubbles settle from the host record after leaving the session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMessagesData.data = undefined
    mockMessagesData.isLoading = false
    mockMessagesData.error = null
    mockMessagesData.hasOlder = false
    mockMessagesData.isFetchingOlder = false
    mockMessagesData.dataUpdatedAt = 0
    Object.assign(mockStreamState, { isActive: false, peerUserMessages: [], discardedCommandUuids: [], sendReceipts: {}, thinkingBlocks: [] })
  })

  const U = '46c36d89-3735-4a18-bf0a-98b40f872316'
  const sentAt = Date.parse('2026-11-19T08:15:15.248Z')
  const before = [createAssistantMessage({ id: 'a-before', createdAt: new Date(sentAt - 60_000) })]
  // More than the 300-item trailing page lands after the send.
  const overnight = Array.from({ length: 320 }, (_, i) =>
    createAssistantMessage({ id: `a-${i}`, createdAt: new Date(sentAt + 60_000 + i * 1000) })
  )
  const startIt = createUserMessage({ id: U, content: { text: 'Start it' }, createdAt: new Date(sentAt + 100) })

  it('a picked-up bubble whose copy is past the loaded page clears on return', () => {
    const { Owner, appeared, pending } = makeOwner([{ localId: 'l1', uuid: U, text: 'Start it', sentAt }])
    mockMessagesData.data = before
    const { rerender } = renderWithProviders(<Owner view="S" />)
    rerender(<Owner view="other" />)

    // Return: the snapshot says the host picked U up, and a fresh load brings the trailing page only.
    mockStreamState.sendReceipts = { [U]: 'picked_up' }
    mockMessagesData.data = overnight.slice(-300)
    mockMessagesData.hasOlder = true
    mockMessagesData.dataUpdatedAt = Date.now() + 1000
    rerender(<Owner view="S" />)

    expect(appeared).toEqual(['l1'])
    expect(pending()).toEqual([])
    expect(screen.queryByText('Start it')).not.toBeInTheDocument()
  })

  it('a bubble whose copy is loaded clears by its id, with no host record', () => {
    const { Owner, appeared } = makeOwner([{ localId: 'l1', uuid: U, text: 'Start it', sentAt }])
    mockMessagesData.data = before
    const { rerender } = renderWithProviders(<Owner view="S" />)
    mockMessagesData.data = [...before, startIt, ...overnight]
    rerender(<Owner view="S" />)
    expect(appeared).toEqual(['l1'])
  })

  it('a queued bubble clears by its id even when the copy is stamped 6 s before the send', () => {
    const { Owner, appeared } = makeOwner([{ localId: 'q1', uuid: 'server-uuid-1', text: 'Steer it', sentAt, queued: true }])
    mockStreamState.isActive = true
    mockMessagesData.data = [...before, createUserMessage({ id: 'server-uuid-1', content: { text: 'Steer it' }, createdAt: new Date(sentAt - 6000) })]
    renderWithProviders(<Owner view="S" />)
    expect(appeared).toEqual(['q1'])
  })

  it('a queued bubble is not cleared by another message with the same text', () => {
    const { Owner, appeared, pending } = makeOwner([{ localId: 'q1', uuid: 'server-uuid-1', text: 'Steer it', sentAt, queued: true }])
    mockStreamState.isActive = true
    mockMessagesData.data = [...before, createUserMessage({ id: 'other-id', content: { text: 'Steer it' }, createdAt: new Date(sentAt - 4000) })]
    renderWithProviders(<Owner view="S" />)
    expect(appeared).toEqual([])
    expect(pending().map((p) => p.localId)).toEqual(['q1'])
  })

  it('a message dropped while away clears on return and its text goes back to the composer', async () => {
    const D = 'queued-dead-uuid'
    const { Owner, appeared, pending } = makeOwner([{ localId: 'l1', uuid: D, text: 'queued while busy', sentAt, queued: true }])
    mockMessagesData.data = []
    mockStreamState.isActive = true
    const { rerender } = renderWithProviders(<Owner view="S" />)
    rerender(<Owner view="other" />)

    // The drop notice went out on the closed feed. The return snapshot carries the record.
    mockStreamState.isActive = false
    mockStreamState.sendReceipts = { [D]: 'never_ran' }
    mockMessagesData.dataUpdatedAt = Date.now() + 1000
    rerender(<Owner view="S" />)
    await act(async () => {})

    expect(appeared).toEqual(['l1'])
    expect(pending()).toEqual([])
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('queued while busy')
  })

  it('a message dropped while watching still clears and returns its text once', async () => {
    const D = 'queued-dead-uuid'
    const { Owner, appeared } = makeOwner([{ localId: 'l1', uuid: D, text: 'queued while busy', sentAt, queued: true }])
    mockMessagesData.data = []
    mockStreamState.isActive = true
    const { rerender } = renderWithProviders(<Owner view="S" />)
    mockStreamState.discardedCommandUuids = [D]
    mockStreamState.sendReceipts = { ...mockStreamState.sendReceipts, [D]: 'never_ran' }
    rerender(<Owner view="S" />)
    await act(async () => {})
    expect(appeared).toEqual(['l1'])
    expect(screen.getByTestId('draft-probe')).toHaveTextContent('queued while busy')
  })
})
