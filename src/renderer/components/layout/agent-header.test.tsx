// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { AgentHeader } from './agent-header'
import type { ApiAgent } from '@renderer/hooks/use-agents'
import { HOVER_SCROLL_DELAY_MS } from '@renderer/components/ui/hover-scroll-text'
import {
  DashboardHeaderProvider,
  useRegisterDashboardHeader,
  type DashboardHeaderRegistration,
} from '@renderer/context/dashboard-header-context'

const mocks = vi.hoisted(() => ({
  routeView: { kind: 'session', id: 'session-1' } as {
    kind: string
    id?: string
    slug?: string
  },
  agentStatus: 'running' as 'running' | 'stopped',
  invokedByAgentSlug: undefined as string | undefined,
  invokedByAgentName: undefined as string | undefined,
  isWidgetRepair: false,
  widgetRepairSlug: undefined as string | undefined,
  mcpInvocation: undefined as { clientName?: string } | undefined,
  scheduledTaskId: undefined as string | undefined,
  scheduledTaskName: undefined as string | undefined,
  integrationId: null as string | null,
  integration: undefined as { id: string; provider: string; name?: string } | undefined,
  sessionIsActive: true,
  forkedFromSessionId: undefined as string | undefined,
  forkedFromSessionName: undefined as string | undefined,
  notableSessions: [] as { id: string; isActive?: boolean; isAwaitingInput?: boolean }[],
  notableReads: [] as (string | null)[],
}))

const agent: ApiAgent = {
  avatar: { color: 'tonal-blue', shape: 'circle' } as const,
  slug: 'test-agent',
  displaySlug: 'test-agent',
  name: 'Test Agent',
  description: 'A test agent',
  createdAt: new Date('2025-01-01'),
  status: 'running',
  containerPort: 3000,
}

vi.mock('@renderer/router/use-route-location', () => ({
  useRouteLocation: () => ({ view: mocks.routeView }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgent: () => ({ data: { ...agent, status: mocks.agentStatus } }),
}))

vi.mock('@renderer/hooks/use-sessions', () => ({
  // No `useSessions` here: the header must not read the agent's whole list.
  useNotableSessions: (slug: string | null) => {
    mocks.notableReads.push(slug)
    return { data: mocks.notableSessions }
  },
  useSession: () => ({
    data: {
      id: 'session-1',
      name: 'Test Session',
      agentSlug: 'test-agent',
      invokedByAgentSlug: mocks.invokedByAgentSlug,
      invokedByAgentName: mocks.invokedByAgentName,
      isWidgetRepair: mocks.isWidgetRepair,
      widgetRepairSlug: mocks.widgetRepairSlug,
      mcpInvocation: mocks.mcpInvocation,
      scheduledTaskId: mocks.scheduledTaskId,
      scheduledTaskName: mocks.scheduledTaskName,
      isActive: mocks.sessionIsActive,
      forkedFromSessionId: mocks.forkedFromSessionId,
      forkedFromSessionName: mocks.forkedFromSessionName,
    },
  }),
}))

vi.mock('@renderer/hooks/use-scheduled-tasks', () => ({
  useScheduledTask: () => ({ data: undefined }),
}))

vi.mock('@renderer/hooks/use-webhook-triggers', () => ({
  useWebhookTrigger: () => ({ data: undefined }),
}))

vi.mock('@renderer/hooks/use-agent-integrations', () => ({
  useSessionAgentIntegrationId: (_slug: string, sessionId: string | null) => ({ data: sessionId ? mocks.integrationId : undefined }),
  useAgentIntegration: (id: string | null) => ({ data: id ? mocks.integration : undefined }),
}))

vi.mock('@renderer/hooks/use-runtime-status', () => ({
  useRuntimeStatus: () => ({
    data: {
      runtimeReadiness: { status: 'READY', message: 'Ready' },
      apiKeyConfigured: true,
    },
    isPending: false,
  }),
}))

vi.mock('@renderer/components/ui/app-link', async () => {
  const { forwardRef } = await import('react')
  type Props = {
    to?: string
    params?: unknown
    search?: unknown
    noDrag?: boolean
    activeOptions?: unknown
  } & AnchorHTMLAttributes<HTMLAnchorElement>
  // Forwards its ref and the rest of its props, as the real one does, so a tooltip trigger can wrap it.
  const AppLink = forwardRef<HTMLAnchorElement, Props>(
    ({ children, to, params, search, noDrag: _noDrag, activeOptions: _activeOptions, ...rest }, ref) => (
      <a
        ref={ref}
        href="/agents/test-agent"
        data-to={to}
        data-params={params ? JSON.stringify(params) : undefined}
        data-search={search ? JSON.stringify(search) : undefined}
        {...rest}
      >
        {children}
      </a>
    ),
  )
  return { AppLink }
})

// The Todo board's header chrome has its own tests (todo-session-chrome.test.tsx).
vi.mock('@renderer/components/todo/todo-session-chrome', () => ({
  TodoSessionBack: () => null,
  TodoSessionControls: () => null,
}))

vi.mock('@renderer/components/agents/agent-context-menu', () => ({
  AgentContextMenu: ({ agent, children }: { agent: ApiAgent; children: ReactNode }) => (
    <span data-testid="agent-breadcrumb-context-menu" data-agent-slug={agent.slug}>{children}</span>
  ),
}))

vi.mock('@renderer/components/sessions/session-context-menu', () => ({
  SessionContextMenu: ({
    sessionId,
    sessionName,
    agentSlug,
    activity,
    children,
  }: {
    sessionId: string
    sessionName: string
    agentSlug: string
    activity: { isActive: boolean; isAwaitingInput: boolean }
    children: ReactNode
  }) => (
    <span
      data-testid="session-breadcrumb-context-menu"
      data-session-id={sessionId}
      data-session-name={sessionName}
      data-agent-slug={agentSlug}
      data-is-active={String(activity.isActive)}
    >
      {children}
    </span>
  ),
}))

const dashboardRegistration: DashboardHeaderRegistration = {
  agentSlug: 'test-agent',
  dashboardSlug: 'nutrition',
  dashboardName: 'Nutrition Dashboard',
  actions: {
    onOpenExternal: vi.fn(),
    onRefresh: vi.fn(),
    refreshState: 'idle',
  },
}

function RegisterDashboardHeader({
  registration = dashboardRegistration,
}: {
  registration?: DashboardHeaderRegistration
}) {
  useRegisterDashboardHeader(registration)
  return null
}

describe('AgentHeader breadcrumbs', () => {
  beforeEach(() => {
    mocks.routeView = { kind: 'session', id: 'session-1' }
    mocks.agentStatus = 'running'
    mocks.invokedByAgentSlug = undefined
    mocks.invokedByAgentName = undefined
    mocks.isWidgetRepair = false
    mocks.widgetRepairSlug = undefined
    mocks.mcpInvocation = undefined
    mocks.scheduledTaskId = undefined
    mocks.scheduledTaskName = undefined
    mocks.integrationId = null
    mocks.integration = undefined
    mocks.sessionIsActive = true
    mocks.forkedFromSessionId = undefined
    mocks.forkedFromSessionName = undefined
    mocks.notableSessions = []
    mocks.notableReads = []
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('takes its activity state from the notable sessions slice, not the full list', () => {
    mocks.notableSessions = [{ id: 'session-9', isAwaitingInput: true }]
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    expect(mocks.notableReads).toContain('test-agent')
    expect(screen.getAllByTestId('agent-status')[0]).toHaveTextContent('needs input')
  })

  it('reuses the agent and session context menus on their breadcrumbs', () => {
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    const agentMenu = screen.getByTestId('agent-breadcrumb-context-menu')
    expect(agentMenu).toHaveAttribute('data-agent-slug', 'test-agent')
    expect(agentMenu).toContainElement(screen.getByTestId('agent-breadcrumb'))

    const sessionMenu = screen.getByTestId('session-breadcrumb-context-menu')
    expect(sessionMenu).toHaveAttribute('data-session-id', 'session-1')
    expect(sessionMenu).toHaveAttribute('data-session-name', 'Test Session')
    expect(sessionMenu).toHaveAttribute('data-agent-slug', 'test-agent')
    expect(sessionMenu).toHaveAttribute('data-is-active', 'true')
    expect(sessionMenu).toContainElement(screen.getByTestId('session-breadcrumb'))
  })

  it('gives each session a fresh session menu, so a running menu action stays with its session', () => {
    const mutation = { mutate: vi.fn(), isPending: false }
    const header = () => (
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />
    )
    const { rerender } = render(header())
    const first = screen.getByTestId('session-breadcrumb-context-menu')

    mocks.routeView = { kind: 'session', id: 'session-2' }
    rerender(header())

    const second = screen.getByTestId('session-breadcrumb-context-menu')
    expect(second).toHaveAttribute('data-session-id', 'session-2')
    expect(second).not.toBe(first)
  })

  it('leaves Fork enabled when the session is idle', () => {
    mocks.sessionIsActive = false
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )
    expect(screen.getByTestId('session-breadcrumb-context-menu')).toHaveAttribute('data-is-active', 'false')
  })

  const renderHeader = () => {
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )
  }

  it('names the calling agent in a crumb before the session, linking to Called from Other Agents', () => {
    mocks.invokedByAgentSlug = 'caller-agent'
    mocks.invokedByAgentName = 'Caller Agent'
    renderHeader()

    const trail = screen.getByTestId('breadcrumb-trail')
    const callerCrumb = screen.getByTestId('inbound-x-agent-breadcrumb')
    expect(callerCrumb).toHaveTextContent('Caller Agent')
    expect(callerCrumb).toHaveAttribute('data-to', '/agents/$slug/called-from-agents')
    expect(trail).toContainElement(callerCrumb)
    expect(trail).toContainElement(screen.getByTestId('session-breadcrumb'))
  })

  it('names the widget a repair session was invoked to fix', () => {
    mocks.isWidgetRepair = true
    mocks.widgetRepairSlug = 'weather'
    renderHeader()

    expect(screen.getByTestId('inbound-x-agent-breadcrumb')).toHaveTextContent('weather')
  })

  it('names the MCP client that started the session', () => {
    mocks.mcpInvocation = { clientName: 'Claude Desktop' }
    renderHeader()

    expect(screen.getByTestId('inbound-x-agent-breadcrumb')).toHaveTextContent('Claude Desktop')
  })

  it('links a scheduled session back to its schedule', () => {
    mocks.scheduledTaskId = 'task-1'
    mocks.scheduledTaskName = 'Proactive heartbeat'
    renderHeader()

    const crumb = screen.getByTestId('schedule-breadcrumb')
    expect(crumb).toHaveTextContent('Proactive heartbeat')
    expect(crumb).toHaveAttribute('data-params', JSON.stringify({ slug: 'test-agent', taskId: 'task-1' }))
  })

  it('names an integration session\'s integration and links to its open conversation', () => {
    mocks.integrationId = 'int-1'
    mocks.integration = { id: 'int-1', provider: 'slack', name: 'Support bot' }
    renderHeader()

    const crumb = screen.getByTestId('integration-breadcrumb')
    expect(crumb).toHaveTextContent('Support bot')
    expect(crumb).toHaveAttribute('data-to', '/agents/$slug/chat/$integrationId')
    expect(crumb).toHaveAttribute('data-params', JSON.stringify({ slug: 'test-agent', integrationId: 'int-1' }))
    expect(crumb).toHaveAttribute('data-search', JSON.stringify({ session: 'session-1' }))
  })

  it('still offers the integration crumb before the integration loads', () => {
    mocks.integrationId = 'int-1'
    renderHeader()

    expect(screen.getByTestId('integration-breadcrumb')).toHaveTextContent('Integration')
  })

  it('shows no provenance crumbs for an ordinary session', () => {
    renderHeader()

    expect(screen.queryByTestId('inbound-x-agent-breadcrumb')).toBeNull()
    expect(screen.queryByTestId('integration-breadcrumb')).toBeNull()
    expect(screen.queryByTestId('schedule-breadcrumb')).toBeNull()
  })

  it('marks a forked session with an icon that opens a link to the source on hover', () => {
    mocks.forkedFromSessionId = 'source-1'
    mocks.forkedFromSessionName = 'Pricing'
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    const indicator = screen.getByTestId('forked-from-indicator')
    expect(screen.queryByTestId('forked-from-popover')).toBeNull()
    fireEvent.pointerEnter(indicator, { pointerType: 'mouse' })
    expect(screen.getByTestId('forked-from-popover')).toHaveTextContent('Branched from Pricing')
    expect(screen.getByTestId('forked-from-link')).toHaveTextContent('Pricing')
  })

  it('opens the fork popover on click and names a deleted source without a link', () => {
    mocks.forkedFromSessionId = 'source-1'
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    fireEvent.click(screen.getByTestId('forked-from-indicator'))
    expect(screen.getByTestId('forked-from-popover')).toHaveTextContent('Branched from a deleted conversation')
    expect(screen.queryByTestId('forked-from-link')).toBeNull()
  })

  it('shows no fork icon for a session that is not a fork', () => {
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )
    expect(screen.queryByTestId('forked-from-indicator')).toBeNull()
  })

  it('clips and hover-scrolls the complete breadcrumb trail as one unit', () => {
    vi.useFakeTimers()
    const mutation = { mutate: vi.fn(), isPending: false }
    const { container } = render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    const trail = screen.getByTestId('breadcrumb-trail')
    const content = trail.firstElementChild as HTMLElement
    const agentCrumb = screen.getByTestId('agent-breadcrumb')
    const sessionCrumb = screen.getByTestId('session-breadcrumb')

    expect(trail).toHaveClass('hover-scroll-text')
    expect(container.querySelectorAll('.hover-scroll-text')).toHaveLength(1)
    expect(content).toHaveClass('hover-scroll-text-content', 'truncate')
    expect(content).toContainElement(agentCrumb)
    expect(content).toContainElement(sessionCrumb)
    expect(agentCrumb).not.toHaveClass('truncate')
    expect(sessionCrumb).not.toHaveClass('truncate')

    Object.defineProperty(trail, 'clientWidth', { configurable: true, value: 120 })
    Object.defineProperty(content, 'scrollWidth', { configurable: true, value: 300 })
    fireEvent.mouseEnter(trail)
    act(() => vi.advanceTimersByTime(HOVER_SCROLL_DELAY_MS))

    expect(trail).toHaveAttribute('data-scrolling', 'true')
    expect(trail).toHaveStyle({ '--hover-scroll-distance': '180px' })
  })

  it('keeps unused breadcrumb header space in the window drag region', () => {
    const mutation = { mutate: vi.fn(), isPending: false }
    render(
      <AgentHeader
        slug="test-agent"
        isViewOnly={false}
        startAgent={mutation as never}
        stopAgent={mutation as never}
      />,
    )

    const dragArea = screen.getByTestId('breadcrumb-drag-area')
    const trail = screen.getByTestId('breadcrumb-trail')

    // ContentShell marks the header as draggable. Keep its flex-filling blank
    // area in that region and opt out only the fitted, interactive breadcrumb.
    expect(dragArea).toHaveClass('min-w-0', 'flex-1')
    expect(dragArea).not.toHaveClass('app-no-drag')
    expect(trail).toHaveClass('w-fit', 'max-w-full', 'app-no-drag')
  })

  it('renders the dashboard name as a breadcrumb and its actions in the shared toolbar', () => {
    mocks.routeView = { kind: 'dashboard', slug: 'nutrition' }
    const mutation = { mutate: vi.fn(), isPending: false }

    const { container } = render(
      <DashboardHeaderProvider>
        <AgentHeader
          slug="test-agent"
          isViewOnly={false}
          startAgent={mutation as never}
          stopAgent={mutation as never}
        />
        <RegisterDashboardHeader />
      </DashboardHeaderProvider>,
    )

    expect(screen.getByTestId('dashboard-breadcrumb')).toHaveTextContent('Nutrition Dashboard')
    expect(screen.getByTestId('dashboard-header-actions')).toBeInTheDocument()

    // One separator between the dashboard's actions and the status chip; the chip holds the power button itself.
    const separators = container.querySelectorAll('[data-orientation="vertical"]')
    expect(separators).toHaveLength(1)
    expect(separators[0]).not.toHaveClass('ml-2')
  })

  it('shows the power-control spinner while the dashboard view wakes the agent', () => {
    mocks.routeView = { kind: 'dashboard', slug: 'nutrition' }
    mocks.agentStatus = 'stopped'
    const mutation = { mutate: vi.fn(), isPending: false }

    render(
      <DashboardHeaderProvider>
        <AgentHeader
          slug="test-agent"
          isViewOnly={false}
          startAgent={mutation as never}
          stopAgent={mutation as never}
        />
        <RegisterDashboardHeader
          registration={{
            ...dashboardRegistration,
            actions: null,
            isAgentStarting: true,
          }}
        />
      </DashboardHeaderProvider>,
    )

    const startButton = screen.getByRole('button', { name: 'Start Agent' })
    expect(startButton).toBeDisabled()
    expect(startButton.querySelector('.animate-spin')).not.toBeNull()
  })
  it('gives a session the side drawer toggle in place of the status chip, and keeps the status readable', () => {
    mocks.routeView = { kind: 'session', id: 'session-1' }
    const mutation = { mutate: vi.fn(), isPending: false }
    render(<AgentHeader slug="test-agent" isViewOnly={false} startAgent={mutation as never} stopAgent={mutation as never} />)

    // No chip and no power button on a session; the drawer's toggle takes that place.
    expect(screen.queryByTestId('agent-power-controls')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Stop Agent' })).toBeNull()
    expect(screen.getByTestId('header-tray-slot')).toBeInTheDocument()
    // The status itself is still there for assistive technology.
    expect(screen.getAllByTestId('agent-status')[0].closest('.sr-only')).not.toBeNull()
  })

  it('keeps the status chip and power button on views that are not a session', () => {
    mocks.routeView = { kind: 'dashboard', slug: 'nutrition' }
    const mutation = { mutate: vi.fn(), isPending: false }
    render(<AgentHeader slug="test-agent" isViewOnly={false} startAgent={mutation as never} stopAgent={mutation as never} />)

    expect(screen.getByTestId('agent-power-controls')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop Agent' })).toBeInTheDocument()
    expect(screen.queryByTestId('header-tray-slot')).toBeNull()
  })
})
