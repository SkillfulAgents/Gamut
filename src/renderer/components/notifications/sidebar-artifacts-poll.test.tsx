// @vitest-environment jsdom
//
// The sidebar's dashboards list (`useArtifacts(slug, { namesOnly: true })`,
// one per expanded agent row) with the real handler and the real hook over a
// fake stream and a counted API: how often /artifacts is asked while idle,
// that each event that can change the list still reads it at once, that the
// cadences while a dashboard starts are untouched, and what a drop does.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

class MockEventSource extends EventTarget {
  static instances: MockEventSource[] = []
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = MockEventSource.OPEN
  constructor(public url: string) {
    super()
    MockEventSource.instances.push(this)
  }
  close() {
    this.readyState = MockEventSource.CLOSED
  }
}
vi.stubGlobal('EventSource', MockEventSource)

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/api')>(),
  apiFetch: mocks.apiFetch,
}))
vi.mock('@renderer/lib/env', () => ({ getApiBaseUrl: () => 'http://localhost:3000', isElectron: () => false }))
vi.mock('@renderer/lib/os-notifications', () => ({ showOSNotification: vi.fn() }))
vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ selectedAgentSlug: null, view: { kind: 'home' } }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, canAccessAgent: () => true }),
}))
// The shared setup's useNavigate returns a new function per render, which would
// reopen the stream each time the handler renders; the router's is stable.
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tanstack/react-router')>(),
  useNavigate: () => navigate,
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({ useUserSettings: () => ({ data: undefined }) }))
vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => ({ data: [] }),
  resolveRouteAgentId: (slug: string | undefined) => slug,
}))

import { STREAM_BACKED_POLL_MS, STREAM_SILENT_AFTER_MS, noteNotificationStreamDown } from '@renderer/lib/notification-stream-health'
import { useArtifacts, type ArtifactInfo } from '@renderer/hooks/use-artifacts'
import { GlobalNotificationHandler } from './global-notification-handler'

const AGENTS = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5']
const url = (slug: string) => `/api/agents/${slug}/artifacts`

function dashboard(slug: string, status: ArtifactInfo['status'] = 'running', name = slug): ArtifactInfo {
  return { slug, name, description: '', status, port: 4000 }
}

let server: Record<string, ArtifactInfo[]> = {}
let failing = false
let requests: string[] = []

/** What an expanded sidebar row asks for. */
function Row({ slug }: { slug: string }) {
  const { data } = useArtifacts(slug, { namesOnly: true })
  return <span data-testid={`row-${slug}`}>{(data ?? []).map((a) => a.name).join(',')}</span>
}

/** What an open dashboard asks for. */
function View({ slug, watching = false, pollFast = false }: { slug: string; watching?: boolean; pollFast?: boolean }) {
  const { data } = useArtifacts(slug, { watching, pollFast })
  return <span data-testid={`view-${slug}`}>{(data ?? []).map((a) => `${a.slug}:${a.status}`).join(',')}</span>
}

const stream = () => MockEventSource.instances[MockEventSource.instances.length - 1]
const count = (slug?: string) => requests.filter((request) => (slug ? request === url(slug) : request.endsWith('/artifacts'))).length
const row = (slug: string) => screen.getByTestId(`row-${slug}`).textContent

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function frame(data: unknown, es: MockEventSource = stream()) {
  await act(async () => {
    es.onmessage?.({ data: JSON.stringify(data) })
    await vi.advanceTimersByTimeAsync(0)
  })
}

/** Time passing on a live stream: the server pings it every 30 s. */
async function advanceWithPings(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 30_000) {
    await advance(Math.min(30_000, ms - elapsed))
    await frame({ type: 'ping' })
  }
}

async function mount(children: React.ReactNode, { handler = true }: { handler?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      {handler && <GlobalNotificationHandler />}
      {children}
    </QueryClientProvider>,
  )
  await advance(0)
  requests = []
  return queryClient
}

const rows = (k: number) => AGENTS.slice(0, k).map((slug) => <Row key={slug} slug={slug} />)

describe('the sidebar\'s artifacts poll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockEventSource.instances = []
    requests = []
    failing = false
    server = Object.fromEntries(AGENTS.map((slug) => [slug, [dashboard('sales')]]))
    mocks.apiFetch.mockImplementation(async (requested: string) => {
      requests.push(requested)
      const slug = /^\/api\/agents\/([^/]+)\/artifacts$/.exec(requested)?.[1]
      if (slug && failing) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => (slug ? server[slug] ?? [] : {}) }
    })
  })

  afterEach(() => {
    cleanup()
    noteNotificationStreamDown()
    vi.useRealTimers()
  })

  describe('requests per idle minute', () => {
    it.each([1, 3, 5])('%i expanded rows: one each per minute without the stream', async (k) => {
      await mount(rows(k))
      await advance(10 * 60_000)
      expect(count()).toBe(10 * k)
    })

    it.each([1, 3, 5])('%i expanded rows: one each per five minutes while the stream delivers', async (k) => {
      await mount(rows(k))
      await frame({ type: 'connected' })
      requests = []

      await advanceWithPings(STREAM_BACKED_POLL_MS - 30_000)
      expect(count()).toBe(0)

      // 30 idle minutes: 6 reads a row, where it was 30.
      requests = []
      await advanceWithPings(30 * 60_000)
      expect(count()).toBe(6 * k)
      for (const slug of AGENTS.slice(0, k)) expect(count(slug)).toBe(6)
    })

    it('a collapsed row asks nothing', async () => {
      function Collapsed() {
        useArtifacts(null, { namesOnly: true })
        return null
      }
      await mount(<Collapsed />)
      await frame({ type: 'connected' })
      requests = []
      await advanceWithPings(10 * 60_000)
      expect(count()).toBe(0)
    })
  })

  describe('what changes the list still reads it at once', () => {
    async function idleRows() {
      await mount(rows(2))
      await frame({ type: 'connected' })
      await advanceWithPings(60_000)
      requests = []
    }

    it.each(['session_idle', 'session_error', 'session_awaiting_input'])('%s: the agent\'s turn stopped', async (type) => {
      await idleRows()
      server['agent-1'] = [dashboard('sales'), dashboard('costs')]
      await frame({ type, agentSlug: 'agent-1', sessionId: 's-1' })
      expect(row('agent-1')).toBe('sales,costs')
      expect(count('agent-1')).toBe(1)
      // Only that agent's row.
      expect(count('agent-2')).toBe(0)
    })

    it('a turn that starts reads nothing', async () => {
      await idleRows()
      await frame({ type: 'session_active', agentSlug: 'agent-1', sessionId: 's-1' })
      expect(count()).toBe(0)
    })

    it('dashboard_status_changed: a dashboard the agent made mid-turn came up', async () => {
      await idleRows()
      server['agent-1'] = [dashboard('sales'), dashboard('costs')]
      await frame({ type: 'dashboard_status_changed', agentSlug: 'agent-1', dashboardSlug: 'costs', status: 'running' })
      expect(row('agent-1')).toBe('sales,costs')
      expect(count('agent-1')).toBe(1)
      expect(count('agent-2')).toBe(0)
    })

    it('agent_status_changed: the agent started or stopped', async () => {
      await idleRows()
      server['agent-2'] = []
      await frame({ type: 'agent_status_changed', agentSlug: 'agent-2', status: 'stopped' })
      expect(row('agent-2')).toBe('')
      expect(count('agent-2')).toBe(1)
      expect(count('agent-1')).toBe(0)
    })

    it('a rename or delete in this window', async () => {
      const queryClient = await mount(rows(2))
      await frame({ type: 'connected' })
      requests = []
      server['agent-1'] = [dashboard('sales', 'running', 'Revenue')]
      await act(async () => {
        void queryClient.invalidateQueries({ queryKey: ['artifacts', 'agent-1'] })
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(row('agent-1')).toBe('Revenue')
      expect(count()).toBe(1)
    })

    it('an expanded row that mounts with a list older than a minute', async () => {
      const queryClient = await mount(rows(1))
      await frame({ type: 'connected' })
      cleanup()
      await advance(61_000)
      requests = []
      server['agent-1'] = [dashboard('sales'), dashboard('costs')]
      render(<QueryClientProvider client={queryClient}><Row slug="agent-1" /></QueryClientProvider>)
      await advance(0)
      expect(row('agent-1')).toBe('sales,costs')
      expect(count('agent-1')).toBe(1)
    })

    it('a change nothing announces is found by the slow poll', async () => {
      await idleRows()
      // Renamed in another window: no event.
      server['agent-1'] = [dashboard('sales', 'running', 'Revenue')]
      await advanceWithPings(STREAM_BACKED_POLL_MS)
      expect(row('agent-1')).toBe('Revenue')
    })
  })

  describe('while a dashboard is starting', () => {
    it('a row whose list holds a starting dashboard reads every second, stream or not', async () => {
      server['agent-1'] = [dashboard('sales', 'starting')]
      await mount(rows(1))
      await frame({ type: 'connected' })
      requests = []
      await advance(10_000)
      expect(count('agent-1')).toBe(10)

      // Up: back to the slow poll.
      server['agent-1'] = [dashboard('sales', 'running')]
      await advance(1_000)
      requests = []
      await advanceWithPings(STREAM_BACKED_POLL_MS - 30_000)
      expect(count('agent-1')).toBe(0)
    })

    it('an open dashboard keeps 300 ms while it waits and 1 s while it watches, beside an expanded row', async () => {
      server['agent-1'] = [dashboard('sales', 'stopped')]
      await mount(<><Row slug="agent-1" /><View slug="agent-1" pollFast watching /></>)
      await frame({ type: 'connected' })
      requests = []
      await advance(3_000)
      expect(count('agent-1')).toBe(10)

      cleanup()
      await mount(<><Row slug="agent-1" /><View slug="agent-1" watching /></>)
      await frame({ type: 'connected' })
      requests = []
      await advance(10_000)
      expect(count('agent-1')).toBe(10)
    })

    it('an open dashboard that is not waiting keeps its 60 s poll with the stream delivering', async () => {
      // A dashboard that exits cleanly reports 'stopped' with no event.
      await mount(<View slug="agent-1" />)
      await frame({ type: 'connected' })
      requests = []
      server['agent-1'] = [dashboard('sales', 'stopped')]
      await advanceWithPings(60_000)
      await advance(1_000)
      expect(screen.getByTestId('view-agent-1').textContent).toBe('sales:stopped')
      await advanceWithPings(9 * 60_000)
      expect(count('agent-1')).toBe(10)
    })
  })

  describe('when the stream does not deliver', () => {
    it('returns to 60 s when the stream drops, reads again on reconnect, then slows', async () => {
      await mount(rows(3))
      await frame({ type: 'connected' })
      await advanceWithPings(60_000)
      requests = []

      const es = stream()
      es.readyState = MockEventSource.CONNECTING
      await act(async () => { es.onerror?.() })
      server['agent-1'] = [dashboard('sales'), dashboard('costs')]
      await advance(5 * 60_000)
      expect(count()).toBe(15)
      expect(row('agent-1')).toBe('sales,costs')

      // Back: what changed during the gap is read at once.
      server['agent-2'] = []
      requests = []
      es.readyState = MockEventSource.OPEN
      await frame({ type: 'connected' })
      expect(count()).toBe(3)
      expect(row('agent-2')).toBe('')

      requests = []
      await advanceWithPings(STREAM_BACKED_POLL_MS - 30_000)
      expect(count()).toBe(0)
    })

    it('returns to 60 s when the stream goes silent without an error', async () => {
      await mount(rows(3))
      await frame({ type: 'connected' })
      requests = []

      // No ping for longer than the server would ever leave it.
      await advance(STREAM_SILENT_AFTER_MS + 15_000)
      requests = []
      await advance(5 * 60_000)
      expect(count()).toBe(15)
    })

    it('polls at 60 s with no handler mounted', async () => {
      await mount(rows(3), { handler: false })
      await advance(5 * 60_000)
      expect(count()).toBe(15)
    })

    it('keeps the last list and keeps polling when a read fails', async () => {
      await mount(rows(1))
      await frame({ type: 'connected' })
      requests = []
      failing = true
      await advanceWithPings(2 * STREAM_BACKED_POLL_MS)
      expect(count('agent-1')).toBe(2)
      expect(row('agent-1')).toBe('sales')

      failing = false
      server['agent-1'] = [dashboard('sales'), dashboard('costs')]
      await advanceWithPings(STREAM_BACKED_POLL_MS)
      await advance(1_000)
      expect(row('agent-1')).toBe('sales,costs')
    })
  })
})
