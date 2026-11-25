import { Power, Square, Clock, Loader2, Zap, MoreVertical, Plug, Cable, GitFork, Wrench, type LucideIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { cn } from '@shared/lib/utils/cn'
import { AppLink } from '@renderer/components/ui/app-link'
import { useRouteLocation } from '@renderer/router/use-route-location'
import { useAgent, type useStartAgent, type useStopAgent } from '@renderer/hooks/use-agents'
import { useNotableSessions, useSession } from '@renderer/hooks/use-sessions'
import { useScheduledTask } from '@renderer/hooks/use-scheduled-tasks'
import { useWebhookTrigger } from '@renderer/hooks/use-webhook-triggers'
import { useAgentIntegration, useSessionAgentIntegrationId } from '@renderer/hooks/use-agent-integrations'
import { formatProviderName } from '@shared/lib/agent-integrations/presentation'
import { useConnectedAccounts } from '@renderer/hooks/use-connected-accounts'
import { useRemoteMcps } from '@renderer/hooks/use-remote-mcps'
import { useRuntimeStatus } from '@renderer/hooks/use-runtime-status'
import { AgentStatus } from '@renderer/components/agents/agent-status'
import { AgentContextMenu } from '@renderer/components/agents/agent-context-menu'
import { SessionContextMenu } from '@renderer/components/sessions/session-context-menu'
import { Separator } from '@renderer/components/ui/separator'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@renderer/components/ui/popover'
import { HoverScrollText } from '@renderer/components/ui/hover-scroll-text'
import { useDashboardHeader } from '@renderer/context/dashboard-header-context'
import { DashboardHeaderActions } from '@renderer/components/dashboards/dashboard-header-actions'
import type { ContainerStatus } from '@shared/lib/container/types'
import { agentActivity, agentAvatarState } from '@shared/lib/types/agent-activity-status'
import { AgentAvatar } from '@renderer/components/agents/agent-avatar/agent-avatar'
import { ScrollAwareNavTitle } from './scroll-aware-title'
import { HeaderTraySlot } from './content-shell'
import { ForkedFromIndicator } from './forked-from-indicator'
import { TodoSessionBack, TodoSessionControls } from '@renderer/components/todo/todo-session-chrome'

interface AgentHeaderProps {
  slug: string
  isViewOnly: boolean
  startAgent: ReturnType<typeof useStartAgent>
  stopAgent: ReturnType<typeof useStopAgent>
}

/**
 * The power button inside the status chip: the agent cards' white bordered button (home-page.tsx), a size up. Its
 * corners are its own size's (the icon radius); the chip's are only a pixel rounder, so the chip stays crisp and the
 * button never looks as round as it.
 */
const CHIP_BUTTON = cn(
  // Its glass is status-chip-button in globals.css.
  'status-chip-button flex h-6 w-6 shrink-0 items-center justify-center rounded-icon text-foreground',
  'cursor-pointer transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
  'disabled:cursor-not-allowed disabled:opacity-60',
)

function BreadcrumbSeparator() {
  return (
    <span aria-hidden="true" className="mx-1.5 text-sm font-light text-muted-foreground">
      /
    </span>
  )
}

/**
 * Where a session came from (its schedule, trigger, integration or caller) is a crumb before its name: a link back
 * to that source, with the full sentence in its tooltip. That replaced a strip above the chat that said the same.
 */
const PROVENANCE_CRUMB =
  'inline-flex items-center gap-1 align-top text-muted-foreground hover:text-foreground transition-colors'

function CrumbIconLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="text-sm font-light">{label}</span>
    </>
  )
}

/** The source's own page (a schedule, a trigger): the same icon and name, as the current page. */
function LeafCrumb({ icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 align-top text-muted-foreground app-no-drag [&>span]:text-foreground">
      <CrumbIconLabel icon={icon} label={label} />
    </span>
  )
}

function CrumbTooltip({ text, children }: { text: string; children: ReactElement }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>
          <p>{text}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** Who started a session from outside: another agent, an MCP client, or a widget's repair. Null for everything else. */
function sessionCaller(session: {
  invokedByAgentSlug?: string | null
  invokedByAgentName?: string | null
  mcpInvocation?: { clientName?: string | null } | null
  isWidgetRepair?: boolean | null
  widgetRepairSlug?: string | null
}): { icon: LucideIcon; label: string; tooltip: string } | null {
  if (session.isWidgetRepair) {
    return {
      icon: Wrench,
      label: session.widgetRepairSlug || 'Widget',
      tooltip: `Invoked to fix widget${session.widgetRepairSlug ? `: ${session.widgetRepairSlug}` : ''}`,
    }
  }
  if (session.mcpInvocation) {
    const client = session.mcpInvocation.clientName
    return {
      icon: Cable,
      label: client || 'MCP',
      tooltip: `Session started through MCP${client ? ` from "${client}"` : ''}`,
    }
  }
  if (session.invokedByAgentSlug) {
    const name = session.invokedByAgentName ?? session.invokedByAgentSlug
    return { icon: GitFork, label: name, tooltip: `Session created by x-agent call from "${name}"` }
  }
  return null
}
/**
 * The agent header chrome (breadcrumb + start/stop) rendered by the shared
 * AgentShell layout, so it stays mounted across every agent sub-view. Which
 * crumbs show is derived from the URL via `useRouteLocation()`; the crumbs
 * themselves are `<AppLink>`s (real `<a href>`), so the agent-name crumb's
 * active styling is route-derived (`data-status`) and survives a cold reload
 * with no hand-computed leaf flag.
 */
export function AgentHeader({ slug, isViewOnly, startAgent, stopAgent }: AgentHeaderProps) {
  const { view } = useRouteLocation()
  const sessionId = view.kind === 'session' ? view.id : null
  const scheduledTaskId = view.kind === 'task' ? view.id : null
  const webhookTriggerId = view.kind === 'webhook' ? view.id : null
  const inboundXAgentOpen = view.kind === 'inboundXAgent'
  const completedTasksOpen = view.kind === 'completedTasks'
  const newSessionOpen = view.kind === 'newSession'
  const apiLogsOpen = view.kind === 'apiLogs'
  const memoriesOpen = view.kind === 'memories'
  const secretsOpen = view.kind === 'secrets'
  const xAgentPermissionsOpen = view.kind === 'xAgentPermissions'
  const connectionsOpen = view.kind === 'connections'
  const dashboardSlug = view.kind === 'dashboard' ? view.slug : null
  const dashboardHeader = useDashboardHeader(slug, dashboardSlug)

  const { data: agent } = useAgent(slug)
  // Only for the two activity flags below: the notable slice holds every live
  // session, where the full list would read (and refetch, on every session
  // event) every session the agent has.
  const { data: sessions } = useNotableSessions(slug)
  const { data: session } = useSession(sessionId, slug)
  const { data: scheduledTask } = useScheduledTask(scheduledTaskId)
  const { data: webhookTrigger } = useWebhookTrigger(webhookTriggerId)
  const { data: integrationId } = useSessionAgentIntegrationId(slug, sessionId)
  const { data: integration } = useAgentIntegration(integrationId ?? null)
  const { isWorking: hasActiveSessions, isAwaiting: hasSessionsAwaitingInput } = agentActivity(agent ?? {}, sessions)
  const { data: runtimeStatus, isPending: isRuntimePending } = useRuntimeStatus()
  const readiness = runtimeStatus?.runtimeReadiness
  const isRuntimeReady = isRuntimePending || readiness?.status === 'READY'
  const isPulling = readiness?.status === 'PULLING_IMAGE'
  const apiKeyConfigured = runtimeStatus?.apiKeyConfigured !== false
  const isAgentStarting = startAgent.isPending || dashboardHeader?.isAgentStarting === true

  return (
    <>
      {/* A session that is a Todo board item: back to the board. */}
      {sessionId && <TodoSessionBack agentSlug={slug} sessionId={sessionId} />}
      <div className="min-w-0 flex-1" data-testid="breadcrumb-drag-area">
        {/* One 20px line (text-sm), the height of every crumb in it, so the
            header's flex centring centres the crumbs. The icon crumbs are
            20px boxes pinned to its top: `align-middle` would set them on the
            baseline + half an x-height, which sits below the line's centre. */}
        <HoverScrollText
          className="w-fit max-w-full text-sm app-no-drag"
          data-testid="breadcrumb-trail"
        >
        <ScrollAwareNavTitle className="items-center gap-2 align-top">
          {/* Travels with the name when the page heading scrolls away; the
              picker stays on the page heading, so this one is display-only. */}
          {agent && <AgentAvatar agent={agent} state={agentAvatarState(agent, sessions)} />}
          {agent ? (
            <AgentContextMenu agent={agent}>
              <AppLink
                to="/agents/$slug"
                params={{ slug }}
                activeOptions={{ exact: true }}
                noDrag
                // Route-derived leaf styling: foreground only when this link is the
                // exact active route (`data-status=active`), muted/clickable otherwise.
                className="text-sm font-light transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground cursor-context-menu"
                data-testid="agent-breadcrumb"
              >
                {agent.name}
              </AppLink>
            </AgentContextMenu>
          ) : (
            <AppLink
              to="/agents/$slug"
              params={{ slug }}
              activeOptions={{ exact: true }}
              noDrag
              className="text-sm font-light transition-colors text-muted-foreground hover:text-foreground data-[status=active]:text-foreground"
              data-testid="agent-breadcrumb"
            >
              Loading...
            </AppLink>
          )}
        </ScrollAwareNavTitle>
        {(() => {
          const taskCrumbId = scheduledTaskId ?? (sessionId ? session?.scheduledTaskId ?? null : null)
          const taskCrumbName = scheduledTask?.name ?? (sessionId ? session?.scheduledTaskName : null)
          if (!taskCrumbId) return null
          const label = taskCrumbName || 'Scheduled Task'
          return (
            <>
              <BreadcrumbSeparator />
              {scheduledTaskId ? (
                <LeafCrumb icon={Clock} label={label} />
              ) : (
                <CrumbTooltip text="Session created by this scheduled job">
                  <AppLink
                    to="/agents/$slug/tasks/$taskId"
                    params={{ slug, taskId: taskCrumbId }}
                    noDrag
                    className={PROVENANCE_CRUMB}
                    data-testid="schedule-breadcrumb"
                  >
                    <CrumbIconLabel icon={Clock} label={label} />
                  </AppLink>
                </CrumbTooltip>
              )}
            </>
          )
        })()}
        {(() => {
          const webhookCrumbId = webhookTriggerId ?? (sessionId ? session?.webhookTriggerId ?? null : null)
          const webhookCrumbName = webhookTrigger?.name ?? webhookTrigger?.triggerType ?? (sessionId ? session?.webhookTriggerName : null)
          if (!webhookCrumbId) return null
          const label = webhookCrumbName || 'Webhook Trigger'
          return (
            <>
              <BreadcrumbSeparator />
              {webhookTriggerId ? (
                <LeafCrumb icon={Zap} label={label} />
              ) : (
                <CrumbTooltip text="Session created by this webhook trigger">
                  <AppLink
                    to="/agents/$slug/webhooks/$webhookId"
                    params={{ slug, webhookId: webhookCrumbId }}
                    noDrag
                    className={PROVENANCE_CRUMB}
                    data-testid="webhook-breadcrumb"
                  >
                    <CrumbIconLabel icon={Zap} label={label} />
                  </AppLink>
                </CrumbTooltip>
              )}
            </>
          )
        })()}
        {sessionId && integrationId && (
          <>
            <BreadcrumbSeparator />
            <CrumbTooltip
              text={integration
                ? `Session from ${formatProviderName(integration.provider)} integration${integration.name ? ` "${integration.name}"` : ''}`
                : 'Session from an agent integration'}
            >
              <AppLink
                to="/agents/$slug/chat/$integrationId"
                params={{ slug, integrationId }}
                search={{ session: sessionId }}
                noDrag
                className={PROVENANCE_CRUMB}
                data-testid="integration-breadcrumb"
              >
                <CrumbIconLabel
                  icon={Plug}
                  label={integration ? integration.name || formatProviderName(integration.provider) : 'Integration'}
                />
              </AppLink>
            </CrumbTooltip>
          </>
        )}
        {sessionId && session && (() => {
          const caller = sessionCaller(session)
          if (!caller) return null
          return (
            <>
              <BreadcrumbSeparator />
              <CrumbTooltip text={caller.tooltip}>
                <AppLink
                  to="/agents/$slug/called-from-agents"
                  params={{ slug }}
                  noDrag
                  className={PROVENANCE_CRUMB}
                  data-testid="inbound-x-agent-breadcrumb"
                >
                  <CrumbIconLabel icon={caller.icon} label={caller.label} />
                </AppLink>
              </CrumbTooltip>
            </>
          )
        })()}
        {sessionId && session?.agentSlug === agent?.slug && (
          <>
            <BreadcrumbSeparator />
            <SessionContextMenu
              key={sessionId}
              sessionId={sessionId}
              sessionName={session?.name || 'Session'}
              agentSlug={slug}
              activity={{
                isActive: !!session?.isActive,
                isAwaitingInput: !!session?.isAwaitingInput,
              }}
            >
              <span
                className="text-sm font-light text-foreground cursor-context-menu app-no-drag"
                data-testid="session-breadcrumb"
              >
                {session?.name || 'Loading...'}
              </span>
            </SessionContextMenu>
            {session?.forkedFromSessionId && (
              <ForkedFromIndicator
                agentSlug={slug}
                sourceSessionId={session.forkedFromSessionId}
                sourceSessionName={session.forkedFromSessionName}
              />
            )}
          </>
        )}
        {dashboardSlug && (
          <>
            <BreadcrumbSeparator />
            <span
              className="text-sm font-light text-foreground app-no-drag"
              data-testid="dashboard-breadcrumb"
            >
              {dashboardHeader?.dashboardName || dashboardSlug}
            </span>
          </>
        )}
        {apiLogsOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">API Logs</span>
          </>
        )}
        {newSessionOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">New Session</span>
          </>
        )}
        {memoriesOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Memories</span>
          </>
        )}
        {secretsOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Secrets</span>
          </>
        )}
        {xAgentPermissionsOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Agent-to-agent Connections</span>
          </>
        )}
        {inboundXAgentOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Called from Other Agents</span>
          </>
        )}
        {completedTasksOpen && (
          <>
            <BreadcrumbSeparator />
            <span className="text-sm font-light text-foreground">Completed One-time Tasks</span>
          </>
        )}
        {connectionsOpen && (
          <ConnectionsCrumbs
            slug={slug}
            detail={view.kind === 'connections' ? view.detail ?? null : null}
          />
        )}
        </HoverScrollText>
      </div>
      <div className="flex items-center gap-0 md:gap-2 shrink-0 app-no-drag">
        {/* …and the board's stepper and the item's action. */}
        {sessionId && <TodoSessionControls agentSlug={slug} sessionId={sessionId} />}
        <DashboardHeaderActions agentSlug={slug} dashboardSlug={dashboardSlug} />
        {dashboardHeader?.actions && (
          <Separator orientation="vertical" className="hidden h-5 md:block" />
        )}
        {/* The status and its power button in one frosted chip, as on the agent cards on the home page, a size up. Mobile
            collapses it into the kebab menu below; view-only has no kebab or power button, so its status stays. */}
        {/* A session shows the side drawer's toggle here in place of the chip: the composer already says what the
            agent is doing. The status stays for assistive technology, which has no other place to read it on this view. */}
        {sessionId && (
          <>
            {agent && (
              <span className="sr-only">
                <AgentStatus
                  status={agent.status}
                  hasActiveSessions={hasActiveSessions}
                  hasSessionsAwaitingInput={hasSessionsAwaitingInput}
                />
              </span>
            )}
            <HeaderTraySlot />
          </>
        )}
        {!sessionId && (agent || !isViewOnly) && (
          <div className={cn('h-[30px] items-center gap-2 rounded-[calc(var(--radius-icon)+1px)] status-chip pl-2.5', isViewOnly ? 'flex pr-2.5' : 'hidden md:flex pr-[2px]')}>
            {agent && (
              <AgentStatus
                status={agent.status}
                hasActiveSessions={hasActiveSessions}
                hasSessionsAwaitingInput={hasSessionsAwaitingInput}
                className="[&>svg]:h-[11px] [&>svg]:w-[11px]"
              />
            )}
            {!isViewOnly && (
              <div className="flex items-center" data-testid="agent-power-controls">
                {agent?.status === 'running' ? (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={CHIP_BUTTON}
                          onClick={() => stopAgent.mutate(slug)}
                          disabled={stopAgent.isPending}
                          aria-label="Stop Agent"
                        >
                          <Square className="h-3 w-3 fill-current" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Stop Agent</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <TooltipProvider delayDuration={0}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex">
                          <button
                            type="button"
                            className={CHIP_BUTTON}
                            onClick={() => startAgent.mutate(slug)}
                            disabled={isAgentStarting || !isRuntimeReady}
                            aria-label="Start Agent"
                          >
                            {isPulling || isAgentStarting ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Power className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </span>
                      </TooltipTrigger>
                      {!apiKeyConfigured ? (
                        <TooltipContent>
                          <p>No API key configured. An administrator needs to set up the LLM API key.</p>
                        </TooltipContent>
                      ) : !isRuntimeReady && readiness ? (
                        <TooltipContent>
                          <p>{readiness.message}</p>
                          {readiness.pullProgress && readiness.pullProgress.percent != null && (
                            <p className="text-xs opacity-80">{readiness.pullProgress.status} ({readiness.pullProgress.percent}%)</p>
                          )}
                        </TooltipContent>
                      ) : (
                        <TooltipContent>
                          <p>Wake up agent</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            )}
          </div>
        )}
        {!isViewOnly && (
          <>
            {/* Mobile: the inline status pill + power controls above are
                `hidden md:*`; collapse them into a kebab on small screens. */}
            {agent && (
              <AgentHeaderMobileMenu
                slug={slug}
                status={agent.status}
                hasActiveSessions={hasActiveSessions}
                hasSessionsAwaitingInput={hasSessionsAwaitingInput}
                startAgent={startAgent}
                stopAgent={stopAgent}
                startDisabled={isAgentStarting || !isRuntimeReady}
                isStarting={isPulling || isAgentStarting}
                wakeDisabledReason={
                  !apiKeyConfigured
                    ? 'No API key configured. An administrator needs to set up the LLM API key.'
                    : !isRuntimeReady
                      ? readiness?.message ?? null
                      : null
                }
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * Mobile-only kebab for the agent header. Desktop keeps the inline status pill +
 * start/stop cluster (`hidden md:*`); below `md` those collapse into this menu
 * (`md:hidden`), which surfaces the agent status plus the Start/Stop action so a
 * touch user can wake or stop the agent without a right-click or hover.
 */
function AgentHeaderMobileMenu({
  slug,
  status,
  hasActiveSessions,
  hasSessionsAwaitingInput,
  startAgent,
  stopAgent,
  startDisabled,
  isStarting,
  wakeDisabledReason,
}: {
  slug: string
  status: ContainerStatus
  hasActiveSessions: boolean
  hasSessionsAwaitingInput: boolean
  startAgent: ReturnType<typeof useStartAgent>
  stopAgent: ReturnType<typeof useStopAgent>
  startDisabled: boolean
  isStarting: boolean
  wakeDisabledReason: string | null
}) {
  const isRunning = status === 'running'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Agent options"
          data-testid="agent-mobile-menu"
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-52 p-1">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <AgentStatus
            status={status}
            hasActiveSessions={hasActiveSessions}
            hasSessionsAwaitingInput={hasSessionsAwaitingInput}
          />
        </div>
        <Separator className="my-1" />
        {isRunning ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-item px-2 py-1.5 text-sm hover:bg-muted transition-colors disabled:pointer-events-none disabled:opacity-50"
            onClick={() => stopAgent.mutate(slug)}
            disabled={stopAgent.isPending}
          >
            <Square className="h-4 w-4 fill-current" />
            Stop Agent
          </button>
        ) : (
          <>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-item px-2 py-1.5 text-sm hover:bg-muted transition-colors disabled:pointer-events-none disabled:opacity-50"
              onClick={() => startAgent.mutate(slug)}
              disabled={startDisabled}
            >
              {isStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Power className="h-4 w-4" />}
              Wake up agent
            </button>
            {wakeDisabledReason && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{wakeDisabledReason}</p>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Header crumbs for the Connections view. The list shows "/ Connections";
 * an open detail view appends the connection name — including the
 * "Connections" segment (clickable, back to the list) only when the detail
 * was opened from the list, so a home-card deep link reads "Agent / Account".
 * The logs subview makes the connection crumb clickable and appends "/ Logs".
 */
function ConnectionsCrumbs({
  slug,
  detail,
}: {
  slug: string
  detail: { rowKey: string; source: 'home' | 'list'; view?: 'logs'; from?: string } | null
}) {
  const { data: accountsData } = useConnectedAccounts()
  const { data: mcpsData } = useRemoteMcps()

  if (!detail) {
    return (
      <>
        <BreadcrumbSeparator />
        <span className="text-sm font-light text-foreground">Connections</span>
      </>
    )
  }

  const accounts = Array.isArray(accountsData?.accounts) ? accountsData.accounts : []
  const mcps = Array.isArray(mcpsData?.servers) ? mcpsData.servers : []
  const connectionName =
    accounts.find((a) => `account-${a.id}` === detail.rowKey)?.displayName ??
    mcps.find((m) => `mcp-${m.id}` === detail.rowKey)?.name ??
    'Connection'

  return (
    <>
      {detail.source === 'list' && (
        <>
          <BreadcrumbSeparator />
          <AppLink
            to="/agents/$slug/connections"
            params={{ slug }}
            // No `search` → drops `?detail`/`?source`, returning to the list.
            noDrag
            className="text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
            data-testid="connections-breadcrumb"
          >
            Connections
          </AppLink>
        </>
      )}
      <BreadcrumbSeparator />
      {detail.view === 'logs' ? (
        <AppLink
          to="/agents/$slug/connections"
          params={{ slug }}
          search={{ detail: detail.rowKey, source: detail.source, from: detail.from }}
          noDrag
          className="text-sm font-light text-muted-foreground hover:text-foreground transition-colors"
        >
          {connectionName}
        </AppLink>
      ) : (
        <span className="text-sm font-light text-foreground">{connectionName}</span>
      )}
      {detail.view === 'logs' && (
        <>
          <BreadcrumbSeparator />
          <span className="text-sm font-light text-foreground">Logs</span>
        </>
      )}
    </>
  )
}
