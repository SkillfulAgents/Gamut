// @vitest-environment jsdom
//
// A message that was sent but is not in the transcript yet is drawn as a
// "ghost" row. MessageList re-renders on every streamed chunk of the reply;
// these tests pin that the ghost does not render with it, and that it still
// renders when what it shows changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, act, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MessageList } from './message-list'
import type { PendingMessage } from './pending-message'
import { _setRenderTracker } from '@renderer/lib/perf'
import { renderWithProviders } from '@renderer/test/test-utils'
import { createUserMessage, createAssistantMessage } from '@renderer/test/factories'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import type { IntegrationMessageDisplay } from '@shared/lib/agent-integrations/message-display-schema'

const mockMessagesData: {
  data: ApiMessageOrBoundary[] | undefined
  isLoading: boolean
  error: Error | null
  fetchOlder: () => void
  hasOlder: boolean
  isFetchingOlder: boolean
} = { data: [], isLoading: false, error: null, fetchOlder: () => {}, hasOlder: false, isFetchingOlder: false }

const mockMutate = vi.fn()
let mockCancelResult: { cancelled: boolean } | Promise<{ cancelled: boolean }> = { cancelled: false }

vi.mock('@renderer/hooks/use-messages', () => ({
  useMessages: () => mockMessagesData,
  // `mutate` is stable in the real hooks, and the rows' memo depends on it.
  useDeleteMessage: () => ({ mutate: mockMutate }),
  useDeleteToolCall: () => ({ mutate: mockMutate }),
  useCancelQueuedMessage: () => ({ mutateAsync: async () => mockCancelResult }),
  TranscriptNotFoundError: class TranscriptNotFoundError extends Error {},
}))

type PeerGhost = {
  uuid: string
  receivedAt: number
  content: string
  sender?: { id: string; name?: string; email?: string; image?: string | null }
  queued?: boolean
  integration?: IntegrationMessageDisplay
}

const mockStreamState = {
  isActive: false,
  isStreaming: false,
  streamingMessage: null as string | null,
  streamingToolUses: [] as Array<{ id: string; name: string; partialInput: string }>,
  isCompacting: false,
  activeSubagents: [] as unknown[],
  completedSubagents: null as Set<string> | null,
  typingUser: null as { id: string; name?: string } | null,
  peerUserMessages: [] as PeerGhost[],
  discardedCommandUuids: [] as string[],
  thinkingBlocks: [] as unknown[],
  error: null as string | null,
  apiErrorCode: null as string | null,
  errorPresentation: null,
}

vi.mock('@renderer/hooks/use-message-stream', () => ({
  useMessageStream: () => mockStreamState,
  clearCompacting: () => {},
  removePeerUserMessage: () => {},
  clearPeerUserMessages: () => {},
  consumeDiscardedCommand: () => {},
  consumeThinkingBlocks: () => {},
}))

vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: () => ({ data: { connected: false, platformBaseUrl: null, orgId: null } }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({
    user: null,
    isAuthMode: false,
    isAuthenticated: false,
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

vi.mock('@renderer/context/connectivity-context', () => ({
  useIsOnline: () => true,
  ConnectivityProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@renderer/hooks/use-elapsed-timer', () => ({
  formatElapsed: (ms: number) => `${Math.floor(ms / 1000)}s`,
  useElapsedTimer: () => null,
}))

vi.mock('@renderer/lib/env', () => ({
  getApiBaseUrl: () => 'http://test-api',
  isElectron: () => false,
  getPlatform: () => 'web',
}))

const SENT_AT = Date.UTC(2026, 0, 1, 12, 0, 0)

const SLACK_CARD: IntegrationMessageDisplay = {
  version: 1,
  integration: { id: 'i-1', name: 'Support bot', provider: 'slack', family: 'chat' },
  event: { type: 'message', label: 'Channel message' },
  request: { text: 'Can you check the deploy?', author: { name: 'Ada Lovelace' } },
  source: { kind: 'channel', title: '#ops' },
}

/** Renders per component name, as the app's own render tracker reports them. */
let renders: Record<string, number> = {}

/**
 * The list under a parent whose state the test owns, so a re-render comes from
 * inside the providers: renderWithProviders' own rerender builds a new
 * QueryClient, which re-renders every row whatever its props are.
 */
function mountList(initial: { pending?: PendingMessage[] }) {
  let setProps: (next: { pending?: PendingMessage[] }) => void = () => {}
  let tick: () => void = () => {}
  function Harness() {
    const [props, set] = useState(initial)
    const [, setN] = useState(0)
    setProps = set
    tick = () => setN((n) => n + 1)
    return <MessageList sessionId="s-1" agentSlug="agent-1" pendingUserMessages={props.pending} />
  }
  const view = renderWithProviders(<Harness />)
  return {
    ...view,
    /** One streamed chunk: the stream hook reports more text, and the list renders. */
    chunk(text: string) {
      mockStreamState.streamingMessage = text
      act(() => tick())
    },
    rerender: () => act(() => tick()),
    setPending: (pending: PendingMessage[]) => act(() => setProps({ pending })),
  }
}

/**
 * Stream a reply of `chunks` deltas and return the renders it caused. The
 * reply's first delta is sent before counting starts: it is the one that makes
 * the list show a streaming row at all (the last persisted answer stops being
 * the latest, and the list settles with a second render of its own).
 */
function streamReply(list: ReturnType<typeof mountList>, chunks: number) {
  let text = 'Reply: '
  list.chunk(text)
  renders = {}
  for (let i = 0; i < chunks; i++) {
    text += `word${i} `
    list.chunk(text)
  }
  return { ...renders }
}

describe('MessageList ghost rows during a streamed reply', () => {
  beforeEach(() => {
    renders = {}
    _setRenderTracker((name) => {
      renders[name] = (renders[name] ?? 0) + 1
    })
    mockMessagesData.data = [
      createUserMessage({ id: 'u-0', content: { text: 'Earlier question' } }),
      createAssistantMessage({ id: 'a-0', content: { text: 'Earlier answer' } }),
    ]
    mockCancelResult = { cancelled: false }
    Object.assign(mockStreamState, {
      isActive: true,
      isStreaming: true,
      streamingMessage: null,
      peerUserMessages: [],
    })
  })

  afterEach(() => {
    _setRenderTracker(() => {})
  })

  it('renders the pending ghost once, not once per chunk', () => {
    const list = mountList({ pending: [{ localId: 'local-1', text: 'What is **new**?', sentAt: SENT_AT }] })
    const ghost = screen.getByTestId('pending-user-message')
    const before = ghost.outerHTML

    const CHUNKS = 50
    const during = streamReply(list, CHUNKS)

    expect(during.MessageList).toBe(CHUNKS)
    // Only the streaming row renders per chunk. With the ghost rendering too
    // this was 2 * CHUNKS.
    expect(during.MessageItem).toBe(CHUNKS)
    expect(during.GhostMessageItem ?? 0).toBe(0)
    // Same node, same markup: nothing about the ghost changed.
    expect(screen.getByTestId('pending-user-message')).toBe(ghost)
    expect(ghost.outerHTML).toBe(before)
    expect(screen.getByText(/word49/)).toBeInTheDocument()
  })

  it('keeps a peer ghost still, although the list rebuilds its sender each render', () => {
    mockStreamState.peerUserMessages = [
      { uuid: 'peer-1', receivedAt: SENT_AT, content: 'Peer question', sender: { id: 'other', name: 'Alice Baker', email: 'alice@example.com' } },
      {
        uuid: 'peer-2',
        receivedAt: SENT_AT,
        content: 'From Slack',
        integration: SLACK_CARD,
      },
    ]
    const list = mountList({})
    expect(screen.getByText('Peer question')).toBeInTheDocument()
    expect(screen.getByText('Alice Baker')).toBeInTheDocument()

    const during = streamReply(list, 20)

    expect(during.MessageItem).toBe(20)
    expect(during.GhostMessageItem ?? 0).toBe(0)
  })

  it('keeps several ghosts still: own, peer and queued', () => {
    mockStreamState.peerUserMessages = [
      { uuid: 'peer-1', receivedAt: SENT_AT, content: 'Peer question', sender: { id: 'other', name: 'Alice', email: '' } },
      { uuid: 'peer-q', receivedAt: SENT_AT, content: 'Peer queued', queued: true, sender: { id: 'other', name: 'Alice', email: '' } },
    ]
    const list = mountList({
      pending: [
        { localId: 'local-1', text: 'Mine', sentAt: SENT_AT },
        { localId: 'local-2', text: 'Mine, queued', sentAt: SENT_AT, queued: true, uuid: 'srv-2' },
      ],
    })
    expect(screen.getByTestId('queued-user-message')).toBeInTheDocument()

    const during = streamReply(list, 10)

    expect(during.MessageItem).toBe(10)
    expect(during.GhostMessageItem ?? 0).toBe(0)
  })

  it('does not render the ghost when the list renders for another reason', () => {
    const list = mountList({ pending: [{ localId: 'local-1', text: 'Hello', sentAt: SENT_AT }] })
    list.rerender()
    renders = {}

    list.rerender()
    list.rerender()

    expect(renders.MessageList).toBe(2)
    expect(renders.MessageItem ?? 0).toBe(0)
  })

  it('does not render the ghost when its server uuid arrives', () => {
    const pending: PendingMessage = { localId: 'local-1', text: 'Hello', sentAt: SENT_AT }
    const list = mountList({ pending: [pending] })
    renders = {}

    // The POST response replaces the entry with a copy that carries the uuid.
    list.setPending([{ ...pending, uuid: 'srv-1' }])

    expect(renders.MessageItem ?? 0).toBe(0)
    expect(screen.getByText('Hello')).toBeInTheDocument()
  })

  it('renders the ghost again when its text, sender or time changes', () => {
    const pending: PendingMessage = {
      localId: 'local-1',
      text: 'First text',
      sentAt: SENT_AT,
      sender: { id: 'me', name: 'Me Myself', email: 'me@example.com' },
    }
    const list = mountList({ pending: [pending] })
    expect(screen.getByText('First text')).toBeInTheDocument()

    renders = {}
    list.setPending([{ ...pending, text: 'Second text' }])
    expect(renders.GhostMessageItem).toBe(1)
    expect(screen.getByText('Second text')).toBeInTheDocument()
    expect(screen.queryByText('First text')).not.toBeInTheDocument()

    renders = {}
    list.setPending([{ ...pending, text: 'Second text', sender: { id: 'me', name: 'Renamed Person', email: 'me@example.com' } }])
    expect(renders.GhostMessageItem).toBe(1)
    expect(screen.getByText('Renamed Person')).toBeInTheDocument()

    renders = {}
    list.setPending([{ ...pending, text: 'Second text', sender: { id: 'me', name: 'Renamed Person', email: 'me@example.com', image: 'data:image/png;base64,AAAA' } }])
    expect(renders.GhostMessageItem).toBe(1)

    // An equal sender in a new object is not a change.
    renders = {}
    list.setPending([{ ...pending, text: 'Second text', sender: { id: 'me', name: 'Renamed Person', email: 'me@example.com', image: 'data:image/png;base64,AAAA' } }])
    expect(renders.GhostMessageItem ?? 0).toBe(0)

    renders = {}
    list.setPending([{ ...pending, text: 'Second text', sentAt: SENT_AT + 60_000 }])
    expect(renders.GhostMessageItem).toBe(1)
  })

  it('renders a peer ghost again when its sender or integration card changes', () => {
    const peer: PeerGhost = { uuid: 'peer-1', receivedAt: SENT_AT, content: 'Peer question', sender: { id: 'other', name: 'Alice Baker', email: 'a@example.com' } }
    mockStreamState.peerUserMessages = [peer]
    const list = mountList({})

    renders = {}
    mockStreamState.peerUserMessages = [{ ...peer, sender: { id: 'other', name: 'Alice Cooper', email: 'a@example.com' } }]
    list.rerender()
    expect(renders.GhostMessageItem).toBe(1)
    expect(screen.getByText('Alice Cooper')).toBeInTheDocument()

    renders = {}
    mockStreamState.peerUserMessages = [{
      ...peer,
      sender: undefined,
      integration: SLACK_CARD,
    }]
    list.rerender()
    expect(renders.GhostMessageItem).toBe(1)
  })

  it('still updates the queued ghost\'s status line, which sits outside the memoized bubble', async () => {
    const list = mountList({ pending: [{ localId: 'local-q', text: 'Queued one', sentAt: SENT_AT, queued: true, uuid: 'srv-q' }] })
    list.chunk('Working')
    expect(screen.getByText('Queued')).toBeInTheDocument()

    renders = {}
    fireEvent.click(screen.getByTestId('cancel-queued-message'))
    // The host answered cancelled:false - the agent already has it.
    await waitFor(() => expect(screen.getByText('Picked up by the agent')).toBeInTheDocument())
    expect(screen.queryByTestId('cancel-queued-message')).not.toBeInTheDocument()
    expect(renders.GhostMessageItem ?? 0).toBe(0)
  })

  it('renders a new ghost once when one is added mid-reply, leaving the first alone', () => {
    const first: PendingMessage = { localId: 'local-1', text: 'First', sentAt: SENT_AT }
    const list = mountList({ pending: [first] })
    list.chunk('Reply so far')

    renders = {}
    list.setPending([first, { localId: 'local-2', text: 'Second, queued', sentAt: SENT_AT + 1000, queued: true }])

    expect(renders.GhostMessageItem).toBe(1)
    expect(screen.getByText('Second, queued')).toBeInTheDocument()
  })
})
