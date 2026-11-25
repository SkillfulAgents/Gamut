// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider } from '@renderer/context/search-context'
import * as api from '@renderer/lib/api'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import * as filter from './filter'
import { SearchDialog } from './search-dialog'

const navigate = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

// The real functions, counted: each call walks every session of every agent.
vi.mock('./filter', async (importOriginal) => {
  const real = await importOriginal<typeof import('./filter')>()
  return { ...real, getRecent: vi.fn(real.getRecent), searchAll: vi.fn(real.searchAll) }
})

vi.mock('@renderer/components/agents/agent-avatar/agent-avatar', () => ({
  AgentAvatar: ({ state }: { state: string }) => <span data-testid="orb" data-state={state} />,
}))

it('updates recent and filtered avatars from the shared agents query while search stays open', async () => {
  const now = new Date()
  const agent: ApiAgent = {
    slug: 'alpha', displaySlug: 'alpha', name: 'Alpha', createdAt: now, lastActivityAt: now,
    status: 'running', containerPort: null, avatar: { color: 'tonal-blue', shape: 'circle' },
    dashboards: [{ name: 'Alpha dashboard', slug: 'alpha-dashboard' }],
  }
  const session: ApiSession = { id: 's1', agentSlug: agent.slug, name: 'Alpha session', createdAt: now, lastActivityAt: now }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], [agent])
  client.setQueryData(['sessions', agent.slug], [session])
  const fetch = vi.spyOn(api, 'apiFetch').mockResolvedValue(Response.json([{ ...agent, hasActiveSessions: true }]))
  render(<QueryClientProvider client={client}><SearchProvider><SearchDialog /></SearchProvider></QueryClientProvider>)
  fireEvent.keyDown(window, { key: 'k', metaKey: true })

  async function expectRows(state: string, badge?: string, filtered = true) {
    const kinds = filtered ? ['agent', 'session', 'dashboard'] : ['agent', 'session']
    await waitFor(() => {
      for (const kind of kinds) {
        const row = within(screen.getByTestId(`search-${kind}-row`))
        expect(row.getByTestId('orb')).toHaveAttribute('data-state', state)
        if (state === 'working') expect(row.getByText('(working)')).toHaveClass('motion-reduce:not-sr-only')
        if (badge) expect(row.getByRole('img')).toHaveAccessibleName(badge)
        else expect(row.queryByRole('img')).toBeNull()
      }
    })
  }

  await expectRows('idle', undefined, false)
  fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'alpha' } })
  await expectRows('idle')
  expect(fetch).not.toHaveBeenCalled()

  await act(() => client.invalidateQueries({ queryKey: ['agents'], exact: true }))
  await expectRows('working')
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/agents')

  const update = (patch: Partial<ApiAgent>) => act(() => {
    client.setQueryData(['agents'], [{ ...agent, ...patch }])
  })
  update({ hasActiveSessions: true, hasUnreadNotifications: true, hasUnreadMention: true })
  await expectRows('working', 'mentioned you')
  update({ hasActiveSessions: true, hasUnreadNotifications: true, hasUnreadMention: true, hasSessionsAwaitingInput: true })
  await expectRows('needs-input', 'needs input')
  update({ hasUnreadNotifications: true })
  await expectRows('done', 'unread notifications')
  update({ status: 'stopped' })
  await expectRows('sleeping')
  expect(fetch).toHaveBeenCalledTimes(1)
})

describe('work done by the dialog', () => {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)
  const makeAgent = (slug: string, minutesAgo: number): ApiAgent => ({
    slug, displaySlug: slug, name: `Agent ${slug}`, createdAt: at(1000), lastActivityAt: at(minutesAgo),
    status: 'running', containerPort: null, avatar: { color: 'tonal-blue', shape: 'circle' },
  })
  const makeSession = (id: string, agentSlug: string, minutesAgo: number): ApiSession =>
    ({ id, agentSlug, name: `Session ${id}`, createdAt: at(1000), lastActivityAt: at(minutesAgo) })

  const one = makeAgent('one', 1)
  const two = makeAgent('two', 2)
  const sorts = () => vi.mocked(filter.getRecent).mock.calls.length + vi.mocked(filter.searchAll).mock.calls.length
  const pressShortcut = () => fireEvent.keyDown(window, { key: 'k', metaKey: true })
  const pressEscape = () => fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' })
  const activeRow = () => screen.getByTestId('search-results').querySelector('.bg-accent')
  const observers = (client: QueryClient, key: unknown[]) =>
    client.getQueryCache().find({ queryKey: key, exact: true })?.getObserversCount()

  // React Query notifies its observers on a later tick; wait for it, so that
  // "nothing rendered" is not just "nothing rendered yet".
  const write = (change: () => void) => act(async () => {
    change()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  function setup() {
    // Fresh enough that opening reads nothing: these tests are about renders.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    client.setQueryData(['agents'], [one, two])
    client.setQueryData(['sessions', 'one'], [makeSession('a', 'one', 3), makeSession('b', 'one', 1)])
    client.setQueryData(['sessions', 'two'], [makeSession('c', 'two', 2)])
    const fetch = vi.spyOn(api, 'apiFetch').mockResolvedValue(Response.json([]))
    render(<QueryClientProvider client={client}><SearchProvider><SearchDialog /></SearchProvider></QueryClientProvider>)
    return { client, fetch }
  }

  const scrollIntoView = vi.fn()

  beforeEach(() => {
    vi.restoreAllMocks()
    // jsdom has none; the dialog calls it when the selection moves.
    Element.prototype.scrollIntoView = scrollIntoView
    scrollIntoView.mockClear()
    vi.mocked(filter.getRecent).mockClear()
    vi.mocked(filter.searchAll).mockClear()
    navigate.mockClear()
  })

  it('sorts nothing and observes no list until it is opened', async () => {
    const { client, fetch } = setup()
    expect(screen.queryByTestId('search-input')).toBeNull()
    await write(() => {
      client.setQueryData(['sessions', 'one'], [makeSession('z', 'one', 0)])
      client.setQueryData(['agents'], [{ ...one, hasActiveSessions: true }, two])
    })
    expect(sorts()).toBe(0)
    expect(observers(client, ['sessions', 'one'])).toBe(0)
    expect(observers(client, ['agents'])).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sorts once on open, and not again as the selection moves', () => {
    setup()
    pressShortcut()
    const rows = screen.getAllByTestId('search-session-row')
    expect(scrollIntoView).not.toHaveBeenCalled()
    // Newest first across agents.
    expect(rows.map((row) => row.getAttribute('data-session-id'))).toEqual(['b', 'c', 'a'])
    const afterOpen = sorts()
    expect(afterOpen).toBe(1)

    const dialog = screen.getByRole('dialog')
    for (let i = 0; i < 4; i++) fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    fireEvent.keyDown(dialog, { key: 'ArrowUp' })
    fireEvent.mouseMove(rows[2])
    expect(activeRow()).toBe(rows[2])
    expect(sorts()).toBe(afterOpen)
    // One scroll per move of the selection, none for opening.
    expect(scrollIntoView).toHaveBeenCalledTimes(6)
  })

  it('sorts again when a list it shows changes while open', async () => {
    const { client } = setup()
    pressShortcut()
    const afterOpen = sorts()
    await write(() => {
      client.setQueryData(['sessions', 'two'], [makeSession('c', 'two', 2), makeSession('d', 'two', 0)])
    })
    expect(screen.getAllByTestId('search-session-row').map((row) => row.getAttribute('data-session-id')))
      .toEqual(['d', 'b', 'c', 'a'])
    expect(sorts()).toBe(afterOpen + 1)
    // The same rows read again (a refetch that found no change) are the same
    // lists: nothing to sort.
    await write(() => {
      client.setQueryData(['sessions', 'two'], client.getQueryData<ApiSession[]>(['sessions', 'two'])!.map((s) => ({ ...s })))
    })
    expect(sorts()).toBe(afterOpen + 1)
  })

  it('once closed, sorts nothing and observes no list, whatever changes', async () => {
    const { client, fetch } = setup()
    pressShortcut()
    expect(observers(client, ['sessions', 'one'])).toBe(1)
    expect(observers(client, ['sessions', 'two'])).toBe(1)
    pressEscape()
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())
    const afterClose = sorts()

    for (let i = 0; i < 5; i++) {
      await write(() => {
        client.setQueryData(['sessions', 'one'], [makeSession(`n${i}`, 'one', 0)])
        client.setQueryData(['agents'], [{ ...one, hasActiveSessions: i % 2 === 0 }, two])
      })
    }
    await act(() => client.invalidateQueries({ queryKey: ['sessions'] }))

    expect(sorts()).toBe(afterClose)
    expect(observers(client, ['sessions', 'one'])).toBe(0)
    expect(observers(client, ['sessions', 'two'])).toBe(0)
    expect(observers(client, ['agents'])).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the lists it read after closing, and shows them at once on the next open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client } = setup()
      // In the app the sidebar holds the agents list; here nothing else does.
      client.setQueryDefaults(['agents'], { gcTime: Infinity })
      pressShortcut()
      pressEscape()
      await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())
      // Well past the default five minutes an unobserved query is kept for.
      await act(() => vi.advanceTimersByTimeAsync(30 * 60_000))
      expect(client.getQueryData(['sessions', 'one'])).toHaveLength(2)

      pressShortcut()
      expect(screen.getAllByTestId('search-session-row')).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads a list older than 30 seconds again on open, and none while closed', async () => {
    const { client, fetch } = setup()
    fetch.mockImplementation((url) => Promise.resolve(Response.json(
      String(url) === '/api/agents/one/sessions' ? [makeSession('fresh', 'one', 0)] : [],
    )))
    client.setQueryData(['sessions', 'one'], [makeSession('a', 'one', 3)], { updatedAt: Date.now() - 31_000 })
    expect(fetch).not.toHaveBeenCalled()

    pressShortcut()
    // The rows it had are there at once; the read replaces them.
    expect(screen.getByTestId('search-results').querySelector('[data-session-id="a"]')).not.toBeNull()
    await waitFor(() => expect(screen.getByTestId('search-results').querySelector('[data-session-id="fresh"]')).not.toBeNull())
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/agents/one/sessions'])
  })

  it('keeps its keys: arrows wrap, Enter opens the selected row and closes, the query is cleared on reopen', async () => {
    setup()
    pressShortcut()
    const input = screen.getByTestId('search-input')
    await waitFor(() => expect(input).toHaveFocus())
    expect(activeRow()).toHaveAttribute('data-agent-slug', 'one')

    // Up from the first row wraps to the last: the oldest session.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeRow()).toHaveAttribute('data-session-id', 'a')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeRow()).toHaveAttribute('data-testid', 'search-agent-row')
    expect(activeRow()).toHaveAttribute('data-agent-slug', 'two')

    // Typing filters and returns the selection to the first row.
    fireEvent.change(input, { target: { value: 'session c' } })
    expect(screen.getAllByTestId('search-session-row')).toHaveLength(1)
    expect(screen.queryByTestId('search-agent-row')).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledExactlyOnceWith({
      to: '/agents/$slug/sessions/$sessionId',
      params: { slug: 'two', sessionId: 'c' },
    })
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())

    pressShortcut()
    expect(screen.getByTestId('search-input')).toHaveValue('')
    expect(activeRow()).toHaveAttribute('data-agent-slug', 'one')
    expect(screen.getAllByTestId('search-session-row')).toHaveLength(3)

    // Escape closes; a query with no match says so and Enter does nothing.
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'nothing like it' } })
    expect(screen.getByText('No matches found')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Enter' })
    expect(navigate).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())
  })
})
