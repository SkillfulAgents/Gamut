// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { SearchProvider } from '@renderer/context/search-context'
import * as api from '@renderer/lib/api'
import type { ApiAgent, ApiSession } from '@shared/lib/types/api'
import { SearchDialog } from './search-dialog'

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
