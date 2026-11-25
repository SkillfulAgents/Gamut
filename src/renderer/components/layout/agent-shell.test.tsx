// @vitest-environment jsdom
import { Fragment, StrictMode, useState, type ComponentType, type ReactNode } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  usePendingMessages,
  useStreamContextUsage,
  type PendingMessagesContextValue,
} from '@renderer/context/pending-messages-context'
import type { SessionUsage } from '@shared/lib/types/agent'
import {
  clearPendingSessionSeeds,
  peekPendingSessionSeed,
  seedPendingSessionMessage,
} from '@renderer/context/pending-session-seed'
import { AgentShell } from './agent-shell'

function SeedConsumer() {
  const { getPendingMessages } = usePendingMessages()
  return <div>{getPendingMessages('session-1')[0]?.text ?? 'missing'}</div>
}

// What the shell's hooks answer, and a way to re-render whoever asked: each
// mocked hook subscribes its caller to `shell`, as the real ones do to their
// own stores.
const shell = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  return {
    Body: null as ComponentType | null,
    contextUsage: null as { totalTokens: number; contextWindow: number } | null,
    startAgent: { isPending: false },
    navigate: (() => {}) as (...args: unknown[]) => void,
    user: null as { id: string; name: string; email: string } | null,
    version: 0,
    contentShellRenders: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit() {
      shell.version += 1
      for (const listener of [...listeners]) listener()
    },
  }
})

vi.mock('@tanstack/react-router', async () => {
  const { memo } = await import('react')
  return {
    // The router's own Outlet is memoized, so the context is the only way a
    // shell render reaches the routes under it.
    Outlet: memo(function Outlet() {
      const Body = shell.Body ?? SeedConsumer
      return <Body />
    }),
    useNavigate: () => shell.navigate,
    useParams: () => ({ slug: 'agent-1', sessionId: 'session-1' }),
  }
})

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ user: shell.user, isAuthMode: shell.user !== null, canUseAgent: () => true }),
}))

vi.mock('@renderer/hooks/use-message-stream', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useMessageStream: () => ({
      contextUsage: useSyncExternalStore(shell.subscribe, () => shell.contextUsage),
    }),
  }
})

vi.mock('@renderer/hooks/use-agents', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    // A mutation result is a new object on each of its state transitions.
    useStartAgent: () => useSyncExternalStore(shell.subscribe, () => shell.startAgent),
    useStopAgent: () => vi.fn(),
  }
})

vi.mock('@renderer/components/ui/sidebar', () => ({
  useSidebar: () => ({ state: 'expanded' }),
}))

vi.mock('@renderer/hooks/use-fullscreen', () => ({
  useFullScreen: () => false,
}))

vi.mock('@renderer/lib/env', () => ({
  getPlatform: () => 'linux',
  isElectron: () => false,
}))

vi.mock('@renderer/components/ui/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('./content-shell', () => ({
  // Stands for everything the shell renders itself: header, banners, frame.
  ContentShell: ({ children }: { children: ReactNode }) => {
    shell.contentShellRenders += 1
    return <>{children}</>
  },
}))

vi.mock('./agent-header', () => ({ AgentHeader: () => null }))
vi.mock('./agent-banners', () => ({ AgentBanners: () => null }))

beforeEach(() => {
  shell.Body = null
  shell.contextUsage = null
  shell.startAgent = { isPending: false }
  shell.user = null
})

describe('AgentShell pending session seed', () => {
  beforeEach(() => {
    clearPendingSessionSeeds()
  })

  it('keeps the wizard seed through the StrictMode render retry and clears it after commit', async () => {
    seedPendingSessionMessage('session-1', 'Hello from wizard', 'message-1')

    render(
      <StrictMode>
        <AgentShell />
      </StrictMode>,
    )

    expect(screen.getByText('Hello from wizard')).toBeTruthy()
    await waitFor(() => expect(peekPendingSessionSeed('session-1')).toBeUndefined())
  })

  // The session route is a lazy chunk: it can render after the shell has
  // committed, and nothing has to render the shell again before it does.
  describe.each([
    ['StrictMode', StrictMode],
    ['no StrictMode', Fragment],
  ])('a session view that mounts after the shell (%s)', (_name, Wrapper) => {
    let showView: (show: boolean) => void = () => {}
    let actions: PendingMessagesContextValue | null = null

    function SeedRows() {
      const { getPendingMessages } = usePendingMessages()
      return <div data-testid="seed-rows">{getPendingMessages('session-1').map((m) => m.text).join(',')}</div>
    }

    function DelayedView() {
      const [show, setShow] = useState(false)
      showView = setShow
      actions = usePendingMessages()
      return show ? <SeedRows /> : null
    }

    const rows = () => screen.getByTestId('seed-rows').textContent
    const contextUsageEvent = () =>
      act(() => {
        shell.contextUsage = { totalTokens: shell.version + 1, contextWindow: 200_000 }
        shell.emit()
      })

    function mountThenShowView() {
      seedPendingSessionMessage('session-1', 'Hello from wizard', 'message-1')
      shell.Body = DelayedView
      render(
        <Wrapper>
          <AgentShell />
        </Wrapper>,
      )
      act(() => showView(true))
      expect(rows()).toBe('Hello from wizard')
    }

    it('takes the seed for good once it is copied, with no shell render in between', () => {
      mountThenShowView()

      expect(peekPendingSessionSeed('session-1')).toBeUndefined()
    })

    it.each([
      ['a context_usage event', true],
      ['nothing', false],
    ])('does not bring the prompt back once the transcript has it, after %s', async (_what, usage) => {
      mountThenShowView()
      if (usage) await contextUsageEvent()

      act(() => actions!.onPendingMessageAppeared('message-1'))

      expect(rows()).toBe('')
      expect(peekPendingSessionSeed('session-1')).toBeUndefined()
      // And it stays gone through later renders of the shell and the view.
      await contextUsageEvent()
      act(() => showView(false))
      act(() => showView(true))
      expect(rows()).toBe('')
    })

    it('shows the prompt once on leaving and reopening before the transcript has it, then drops it', async () => {
      mountThenShowView()
      await contextUsageEvent()

      act(() => showView(false))
      await contextUsageEvent()
      act(() => showView(true))
      expect(rows()).toBe('Hello from wizard')

      act(() => actions!.onPendingMessageAppeared('message-1'))
      expect(rows()).toBe('')
      act(() => showView(false))
      act(() => showView(true))
      expect(rows()).toBe('')
      expect(peekPendingSessionSeed('session-1')).toBeUndefined()
    })

    it('drops a cleared session for good', () => {
      mountThenShowView()

      act(() => actions!.clearPendingMessagesForSession('session-1'))

      expect(rows()).toBe('')
    })
  })
})

describe('AgentShell context renders', () => {
  // Stand-ins for the three ways the routes under the shell read it:
  // SessionRoute and AgentHomeRoute take a callback, SessionView also reads the
  // session's pending messages, and SessionView reads the context usage.
  const renders = { actions: 0, pending: 0, usage: 0 }
  const seen: { value: PendingMessagesContextValue | null; values: Set<PendingMessagesContextValue> } = {
    value: null,
    values: new Set(),
  }

  function ActionsReader() {
    const value = usePendingMessages()
    renders.actions += 1
    seen.value = value
    seen.values.add(value)
    return null
  }

  function PendingReader() {
    const { getPendingMessages } = usePendingMessages()
    renders.pending += 1
    const pending = getPendingMessages('session-1')
    return (
      <ul data-testid="pending">
        {pending.map((m) => (
          <li key={m.localId}>{`${m.text}|${m.uuid ?? 'no-uuid'}|${m.queued ? 'queued' : 'sent'}|${m.sender?.name ?? 'no-sender'}`}</li>
        ))}
      </ul>
    )
  }

  function UsageReader() {
    const usage = useStreamContextUsage()
    renders.usage += 1
    return <div data-testid="usage">{usage ? `${usage.totalTokens}/${usage.contextWindow}` : 'none'}</div>
  }

  function Body() {
    return (
      <>
        <ActionsReader />
        <PendingReader />
        <UsageReader />
      </>
    )
  }

  let showLate: (show: boolean) => void = () => {}
  function LateBody() {
    const [show, setShow] = useState(false)
    showLate = setShow
    return (
      <>
        <ActionsReader />
        {show && <PendingReader />}
      </>
    )
  }

  function mount() {
    shell.Body = Body
    render(<AgentShell />)
    renders.actions = 0
    renders.pending = 0
    renders.usage = 0
    shell.contentShellRenders = 0
    seen.values.clear()
    seen.values.add(seen.value!)
  }

  const pendingRows = () => screen.getByTestId('pending').textContent
  const contextUsage = (totalTokens: number): SessionUsage => ({ totalTokens, contextWindow: 200_000 })
  const emitContextUsage = (totalTokens: number) =>
    act(() => {
      shell.contextUsage = contextUsage(totalTokens)
      shell.emit()
    })
  const rerenderShell = () =>
    act(() => {
      shell.startAgent = { isPending: !shell.startAgent.isPending }
      shell.emit()
    })

  beforeEach(() => {
    clearPendingSessionSeeds()
    shell.navigate = () => {}
  })

  it('keeps one context value across shell renders that change nothing in it', () => {
    mount()

    for (let i = 0; i < 4; i += 1) rerenderShell()

    // The shell did render; the count below is not zero for want of renders.
    expect(shell.contentShellRenders).toBe(4)
    expect(seen.values.size).toBe(1)
    expect(renders).toEqual({ actions: 0, pending: 0, usage: 0 })
  })

  it('a context_usage event reaches only the reader of the context usage', () => {
    mount()

    emitContextUsage(1_000)
    emitContextUsage(2_000)
    emitContextUsage(3_000)
    emitContextUsage(4_000)

    expect(screen.getByTestId('usage').textContent).toBe('4000/200000')
    expect(renders).toEqual({ actions: 0, pending: 0, usage: 4 })
    expect(seen.values.size).toBe(1)
    // Nor the shell itself: its header, banners and frame render with it.
    expect(shell.contentShellRenders).toBe(0)
  })

  it('a turn re-renders pending-message readers once per change to the store, and no more', () => {
    mount()

    // What one sent message does to the shell over a turn: the optimistic row,
    // the POST's uuid, the row's replacement by the transcript, interleaved
    // with the stream's context usage and unrelated shell renders.
    act(() => seen.value!.onMessageSent('hello', 'local-1', false))
    expect(pendingRows()).toBe('hello|no-uuid|sent|no-sender')
    emitContextUsage(1_000)
    rerenderShell()
    act(() => seen.value!.onMessageUuidAssigned('local-1', 'uuid-1', true))
    expect(pendingRows()).toBe('hello|uuid-1|queued|no-sender')
    emitContextUsage(2_000)
    emitContextUsage(3_000)
    rerenderShell()
    act(() => seen.value!.onPendingMessageAppeared('local-1'))
    expect(pendingRows()).toBe('')
    emitContextUsage(4_000)

    expect(renders).toEqual({ actions: 3, pending: 3, usage: 4 })
    // Three store changes and two unrelated renders; none for the four usage events.
    expect(shell.contentShellRenders).toBe(5)
  })

  it('does not re-render anyone for a change that leaves the store as it was', () => {
    mount()

    act(() => seen.value!.onMessageUuidAssigned('unknown', 'uuid-1', false))
    act(() => seen.value!.onPendingMessageAppeared('unknown'))
    act(() => seen.value!.clearPendingMessagesForSession('session-1'))
    act(() => seen.value!.clearPendingMessagesForSession('another-session'))

    expect(renders).toEqual({ actions: 0, pending: 0, usage: 0 })
  })

  it('re-renders pending-message readers when a session is cleared', () => {
    mount()
    act(() => seen.value!.onMessageSent('hello', 'local-1', false))
    expect(pendingRows()).toBe('hello|no-uuid|sent|no-sender')

    act(() => seen.value!.clearPendingMessagesForSession('session-1'))

    expect(pendingRows()).toBe('')
  })

  it('hands out new callbacks when the signed-in user changes, so a row sent after carries them', () => {
    mount()
    const before = seen.value!

    act(() => {
      shell.user = { id: 'user-1', name: 'Ada', email: 'ada@example.com' }
      shell.startAgent = { isPending: true }
      shell.emit()
    })

    expect(seen.value).not.toBe(before)
    act(() => seen.value!.onMessageSent('hello', 'local-1', false))
    expect(pendingRows()).toBe('hello|no-uuid|sent|Ada')
  })

  it('a created session navigates without a render of its own, and the route that mounts next reads its first message', () => {
    shell.navigate = vi.fn()
    shell.Body = LateBody
    render(<AgentShell />)
    renders.actions = 0

    act(() => seen.value!.onSessionCreated('session-1', 'first message', 'uuid-1'))

    expect(shell.navigate).toHaveBeenCalledWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'agent-1', sessionId: 'session-1' },
    })
    expect(renders.actions).toBe(0)
    expect(screen.queryByTestId('pending')).toBeNull()

    // The navigation is what renders the session route; it reads the store then.
    act(() => showLate(true))
    expect(pendingRows()).toBe('first message|uuid-1|sent|no-sender')
  })
})
