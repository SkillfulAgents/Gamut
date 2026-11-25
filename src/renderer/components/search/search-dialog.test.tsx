// @vitest-environment jsdom
import { Profiler } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query'
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

const viewer = vi.hoisted(() => ({ isAuthMode: false, isAdmin: false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => viewer }))

const openSettings = vi.hoisted(() => vi.fn())
vi.mock('@renderer/context/dialog-context', () => ({
  useDialogs: () => ({ openSettings, closeSettings: () => {}, openWizard: () => {} }),
}))

function renderSearch(client: QueryClient) {
  openSettings.mockClear()
  render(<QueryClientProvider client={client}><SearchProvider><SearchDialog /></SearchProvider></QueryClientProvider>)
  fireEvent.keyDown(window, { key: 'k', metaKey: true })
}

function settingsRows() {
  return screen.queryAllByTestId('search-settings-row').map((row) => row.getAttribute('data-settings-tab'))
}

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
  renderSearch(client)

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

it('lists settings pages only for a query, last, and opens the chosen one in Settings', async () => {
  const now = new Date()
  const agent: ApiAgent = {
    slug: 'browser-bot', displaySlug: 'browser-bot', name: 'Browser Bot', createdAt: now, lastActivityAt: now,
    status: 'stopped', containerPort: null, avatar: { color: 'tonal-blue', shape: 'circle' },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], [agent])
  client.setQueryData(['sessions', agent.slug], [])
  renderSearch(client)

  await waitFor(() => expect(screen.getByTestId('search-agent-row')).toBeInTheDocument())
  expect(settingsRows()).toEqual([])

  const input = screen.getByTestId('search-input')
  fireEvent.change(input, { target: { value: 'browser' } })
  await waitFor(() => expect(settingsRows()).toEqual(['browser', 'logins']))
  // The agent stays first, so Enter still opens it; the settings come after.
  const sections = screen.getAllByTestId('search-section').map((el) => el.getAttribute('data-section'))
  expect(sections).toEqual(['Agents', 'Settings'])
  const logins = screen.getAllByTestId('search-settings-row')[1]
  expect(logins).toHaveTextContent('Logins')
  expect(logins).toHaveTextContent('Agent Capabilities · Browser vault')

  // A page found by what is on it: only the settings match, so it is the first row.
  fireEvent.change(input, { target: { value: 'anthropic' } })
  await waitFor(() => expect(settingsRows()).toEqual(['llm']))
  expect(screen.queryByTestId('search-agent-row')).toBeNull()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(openSettings).toHaveBeenCalledExactlyOnceWith('llm')
  await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())
})

it('opens a settings page with one click', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['agents'], [])
  renderSearch(client)

  fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'model providers' } })
  const row = await screen.findByTestId('search-settings-row')
  expect(row).toHaveTextContent('Model Providers')
  fireEvent.click(row)
  expect(openSettings).toHaveBeenCalledExactlyOnceWith('llm')
})

it('offers only the settings pages the viewer has', async () => {
  viewer.isAuthMode = true
  try {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['agents'], [])
    renderSearch(client)
    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'browser use' } })
    // A member in auth mode has no Browser Use page, so there is nothing to offer.
    await screen.findByText('No matches found')
    expect(settingsRows()).toEqual([])
  } finally {
    viewer.isAuthMode = false
  }
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
    // Every commit of anything under the dialog, its closed frame included.
    const commits = { count: 0 }
    render(
      <QueryClientProvider client={client}>
        <SearchProvider>
          <Profiler id="search" onRender={() => { commits.count++ }}><SearchDialog /></Profiler>
        </SearchProvider>
      </QueryClientProvider>,
    )
    return { client, fetch, commits }
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
    openSettings.mockClear()
  })

  it('sorts and renders nothing until it is opened', async () => {
    const { client, fetch, commits } = setup()
    expect(screen.queryByTestId('search-input')).toBeNull()
    const mounted = commits.count
    await write(() => {
      client.setQueryData(['sessions', 'one'], [makeSession('z', 'one', 0)])
      client.setQueryData(['agents'], [{ ...one, hasActiveSessions: true }, two])
    })
    expect(sorts()).toBe(0)
    expect(commits.count).toBe(mounted)
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

  it('once closed, sorts and renders nothing, whatever changes', async () => {
    const { client, fetch, commits } = setup()
    pressShortcut()
    expect(observers(client, ['sessions', 'one'])).toBe(1)
    expect(observers(client, ['sessions', 'two'])).toBe(1)
    pressEscape()
    await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())
    const afterClose = sorts()
    const closed = commits.count

    for (let i = 0; i < 5; i++) {
      await write(() => {
        client.setQueryData(['sessions', 'one'], [makeSession(`n${i}`, 'one', 0)])
        client.setQueryData(['agents'], [{ ...one, hasActiveSessions: i % 2 === 0 }, two])
      })
    }
    await act(() => client.invalidateQueries({ queryKey: ['sessions'] }))

    expect(sorts()).toBe(afterClose)
    expect(commits.count).toBe(closed)
    // Each list is held in the cache by one observer that neither reads nor
    // notifies: the invalidation above fetched nothing.
    expect(observers(client, ['sessions', 'one'])).toBe(1)
    expect(observers(client, ['sessions', 'two'])).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('lets go of the sessions of an agent that has left, and keeps the others', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client } = setup()
      pressShortcut()
      pressEscape()
      await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())

      // Agent two is deleted while search is closed.
      await write(() => client.setQueryData(['agents'], [one]))
      expect(observers(client, ['sessions', 'two'])).toBe(0)
      // Still there for as long as any unobserved query is (five minutes by default)...
      await act(() => vi.advanceTimersByTimeAsync(4 * 60_000))
      expect(client.getQueryData(['sessions', 'two'])).toHaveLength(1)
      // ...and then collected, while the remaining agent's list stays.
      await act(() => vi.advanceTimersByTimeAsync(6 * 60_000))
      expect(client.getQueryCache().find({ queryKey: ['sessions', 'two'], exact: true })).toBeUndefined()
      expect(client.getQueryData(['sessions', 'one'])).toHaveLength(2)

      pressShortcut()
      expect(screen.getAllByTestId('search-session-row').map((row) => row.getAttribute('data-session-id'))).toEqual(['b', 'a'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets go of a deleted agent\'s sessions when the agent leaves while search is open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client } = setup()
      pressShortcut()
      await write(() => client.setQueryData(['agents'], [one]))
      expect(screen.getAllByTestId('search-session-row')).toHaveLength(2)
      pressEscape()
      await waitFor(() => expect(screen.queryByTestId('search-input')).toBeNull())
      await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
      expect(client.getQueryCache().find({ queryKey: ['sessions', 'two'], exact: true })).toBeUndefined()
      expect(client.getQueryData(['sessions', 'one'])).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does work in proportion to the number of agents when their lists arrive together', async () => {
    // Each list that arrives must not walk every agent again: with N agents
    // that is N squared (500 agents: 252,004 result proxies, where one walk
    // per render is about 2,000).
    async function proxiesFor(count: number) {
      const agents = Array.from({ length: count }, (_, i) => makeAgent(`a${i}`, i))
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
      client.setQueryData(['agents'], agents)
      const fetch = vi.spyOn(api, 'apiFetch').mockImplementation((url) => {
        const slug = String(url).split('/')[3]
        return Promise.resolve(Response.json([makeSession(`s-${slug}`, slug, 1)]))
      })
      const proxies = vi.spyOn(QueryObserver.prototype, 'trackResult')
      render(<QueryClientProvider client={client}><SearchProvider><SearchDialog /></SearchProvider></QueryClientProvider>)
      pressShortcut()
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(count)
        expect(client.isFetching()).toBe(0)
        expect(screen.getAllByTestId('search-session-row')).toHaveLength(10)
      })
      const made = proxies.mock.calls.length
      const sorted = sorts()
      cleanup()
      client.clear()
      vi.restoreAllMocks()
      vi.mocked(filter.getRecent).mockClear()
      return { made, sorted }
    }

    const small = await proxiesFor(50)
    const large = await proxiesFor(200)
    // Four times the agents: about four times the work, not sixteen.
    expect(large.made).toBeLessThanOrEqual(small.made * 6)
    expect(large.made).toBeLessThanOrEqual(200 * 10)
    // And the lists that arrive together are sorted together, not one by one.
    expect(large.sorted).toBeLessThanOrEqual(10)
  })

  it('shows the settings pages this viewer has while the agents list is still loading', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The agents request never answers.
    vi.spyOn(api, 'apiFetch').mockReturnValue(new Promise(() => {}))
    render(<QueryClientProvider client={client}><SearchProvider><SearchDialog /></SearchProvider></QueryClientProvider>)
    pressShortcut()
    expect(screen.getByText('No recent agents')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'browser' } })
    expect(settingsRows()).toEqual(['browser', 'logins'])
    expect(screen.queryByTestId('search-agent-row')).toBeNull()
    fireEvent.keyDown(screen.getByTestId('search-input'), { key: 'Enter' })
    expect(openSettings).toHaveBeenCalledExactlyOnceWith('browser')

    // A member in auth mode has no Browser Use page: it is not offered, loading or not.
    viewer.isAuthMode = true
    try {
      pressShortcut()
      fireEvent.change(screen.getByTestId('search-input'), { target: { value: 'browser use' } })
      expect(settingsRows()).toEqual([])
      expect(screen.getByText('No matches found')).toBeInTheDocument()
    } finally {
      viewer.isAuthMode = false
    }
  })

  it('keeps the lists it read after closing, and shows them at once on the next open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { client } = setup()
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
