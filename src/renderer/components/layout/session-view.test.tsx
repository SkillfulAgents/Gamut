// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SessionView } from './session-view'

const xAgentSession = {
  id: 'x-session', agentSlug: 'target-agent', name: 'Invoked by Caller Agent',
  invokedByAgentSlug: 'caller-agent', invokedByAgentName: 'Caller Agent',
}
const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  markRead: vi.fn(),
  setMarkedUnread: vi.fn(),
  // Reports whether a dot was actually showing; defaults to the common no-op open.
  clearUnread: vi.fn(() => false),
  session: {} as Record<string, unknown>,
  canUseAgent: true,
  commentsEnabled: [] as Array<boolean | undefined>,
  search: {} as Record<string, unknown>,
  chatColumnProps: undefined as undefined | { messageTarget?: { id: string; onSettled: (outcome: string) => void } },
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  useSession: () => ({ data: mocks.session, error: null }),
  // Opening a session clears any "mark as unread" flag alongside the
  // notification read-marking below.
  useSetSessionMarkedUnread: () => ({ mutate: mocks.setMarkedUnread }),
  useClearSessionUnread: () => mocks.clearUnread,
}))

vi.mock('@renderer/hooks/use-notifications', () => ({
  useMarkSessionNotificationsRead: () => ({ mutate: mocks.markRead }),
}))

vi.mock('@renderer/context/pending-messages-context', () => ({
  usePendingMessages: () => ({
    getPendingMessages: () => [],
    onMessageSent: vi.fn(),
    onMessageUuidAssigned: vi.fn(),
    onPendingMessageAppeared: vi.fn(),
  }),
  useStreamContextUsage: () => null,
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ canUseAgent: () => mocks.canUseAgent }),
}))

vi.mock('@renderer/lib/perf', () => ({ useRenderTracker: () => {} }))
vi.mock('@renderer/hooks/use-session-search', () => ({ useSessionSearch: () => ({}) }))
vi.mock('@renderer/components/messages/session-search-bar', () => ({
  SessionSearchBar: () => null,
}))
vi.mock('./session-chat-column', () => ({
  SessionChatColumn: (props: NonNullable<typeof mocks.chatColumnProps>) => {
    mocks.chatColumnProps = props
    return null
  },
}))
vi.mock('@renderer/context/file-preview-context', () => ({
  FilePreviewProvider: ({ children, commentsEnabled }: { children: ReactNode; commentsEnabled?: boolean }) => {
    mocks.commentsEnabled.push(commentsEnabled)
    return children
  },
}))
vi.mock('@renderer/context/workflow-context', () => ({
  WorkflowProvider: ({ children }: { children: ReactNode }) => children,
}))

describe('SessionView unread clearing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session = xAgentSession
    mocks.clearUnread.mockReturnValue(false)
  })

  it('takes the dot down in the caches on mount and writes through immediately', () => {
    mocks.clearUnread.mockReturnValue(true)
    render(<SessionView agentSlug="target-agent" sessionId="x-session" />)

    expect(mocks.clearUnread).toHaveBeenCalledWith('target-agent', 'x-session')
    // A dot that was actually showing must not be able to come back on the next
    // refetch, so its write does not wait out the quick-navigation debounce.
    expect(mocks.markRead).toHaveBeenCalledWith('x-session')
    expect(mocks.setMarkedUnread).toHaveBeenCalledWith({
      sessionId: 'x-session',
      agentSlug: 'target-agent',
      markedUnread: false,
    })
  })

  it('keeps the debounce for an open with no dot showing', () => {
    vi.useFakeTimers()
    try {
      render(<SessionView agentSlug="target-agent" sessionId="x-session" />)

      expect(mocks.markRead).not.toHaveBeenCalled()
      expect(mocks.setMarkedUnread).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1000)
      expect(mocks.markRead).toHaveBeenCalledWith('x-session')
      expect(mocks.setMarkedUnread).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionView provenance', () => {
  it('draws no bar above the chat for an automated session; its source is a header crumb', () => {
    mocks.session = { ...xAgentSession, scheduledTaskId: 'task-1', scheduledTaskName: 'Nightly' }
    const { container } = render(<SessionView agentSlug="target-agent" sessionId="x-session" />)

    // A top banner would also stop the transcript scrolling under the glass header (globals.css).
    expect(container.querySelector('[data-top-banner]')).toBeNull()
  })
})

describe('SessionView fork provenance', () => {
  it('draws no bar above the chat for a fork; the thread marks the fork point instead', () => {
    mocks.session = { id: 'fork-1', agentSlug: 'agent-a', name: 'Pricing (fork)', forkedFromSessionId: 'src-1', forkedFromSessionName: 'Pricing' }
    render(<SessionView agentSlug="agent-a" sessionId="fork-1" />)

    expect(screen.queryByTestId('fork-session-banner')).toBeNull()
  })
})

it('does not clear unread state before a session exists', () => {
  vi.clearAllMocks()
  render(<SessionView agentSlug="target-agent" sessionId={null} />)
  fireEvent(document, new Event('visibilitychange'))
  expect(mocks.clearUnread).not.toHaveBeenCalled()
  expect(mocks.markRead).not.toHaveBeenCalled()
  expect(mocks.setMarkedUnread).not.toHaveBeenCalled()
})

describe('SessionView file comments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session = {}
    mocks.canUseAgent = true
    mocks.commentsEnabled = []
  })

  it('turns file comments off for a member who can only view the agent', () => {
    mocks.canUseAgent = false
    render(<SessionView agentSlug="target-agent" sessionId="s1" />)

    expect(mocks.commentsEnabled.at(-1)).toBe(false)
  })

  it('keeps file comments on for a member who can use the agent', () => {
    render(<SessionView agentSlug="target-agent" sessionId="s1" />)

    expect(mocks.commentsEnabled.at(-1)).toBe(true)
  })
})

describe('SessionView mention landing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session = xAgentSession
    mocks.search = { message: 'msg-7' }
  })

  it('hands the message to the transcript, then drops it from the URL', () => {
    render(<SessionView agentSlug="target-agent" sessionId="x-session" />)
    expect(mocks.chatColumnProps?.messageTarget?.id).toBe('msg-7')

    mocks.chatColumnProps!.messageTarget!.onSettled('landed')
    expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '.', replace: true }))
    // Only the message leaves the URL.
    const { search } = mocks.navigate.mock.calls.at(-1)![0] as { search: (prev: Record<string, unknown>) => Record<string, unknown> }
    expect(search({ message: 'msg-7', other: 1 })).toEqual({ message: undefined, other: 1 })
  })

  it('asks the transcript for nothing without a message in the URL', () => {
    mocks.search = {}
    render(<SessionView agentSlug="target-agent" sessionId="x-session" />)
    expect(mocks.chatColumnProps?.messageTarget).toBeUndefined()
  })
})
