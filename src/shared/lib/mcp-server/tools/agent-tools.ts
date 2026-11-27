/**
 * list_agents: the agents the person has a role on, through the x-agent
 * service with a user caller (its ACL filter), with the status the app's
 * agent list shows, and the resume the agents' own list_agents gives.
 */
import { z } from 'zod'
import { listAgentsWithStatus } from '@shared/lib/services/agent-service'
import { listVisibleAgents } from '@shared/lib/services/x-agent/operations'
import { xAgentCallerFor } from '../context'
import { defineTool, READ_ONLY_ANNOTATIONS } from '../tool-definition'
import { countFitting, MAX_RESULT_CHARS, McpToolError, truncateText } from '../tool-result'

const AGENTS_PAGE_SIZE = 50
const DESCRIPTION_MAX_CHARS = 1_000

export const listAgents = defineTool({
  name: 'list_agents',
  title: 'List agents',
  description: 'The Gamut agents you have a role on: slug (pass it to list_sessions and read_session), name, description, status, whether it is the Team Brain agent, and its resume: members, when it was created, whether a session is running or needs input, when it was last active, session counts, dashboards, and the services it has accounts for.',
  scope: 'read',
  input: z.object({
    offset: z.number().int().min(0).optional().describe('Where to continue: the next_offset of the previous call. Default 0.'),
  }),
  output: z.object({
    agents: z.array(z.object({
      slug: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      team_brain: z.boolean(),
      created_at: z.string(),
      members: z.array(z.object({
        name: z.string(),
        role: z.string(),
        kind: z.enum(['person', 'agent']),
        invited: z.boolean().optional(),
      })),
      member_count: z.number().int(),
      session_running: z.boolean(),
      needs_input: z.boolean(),
      last_activity_at: z.string().nullable(),
      session_count: z.number().int(),
      automated_session_count: z.number().int(),
      dashboards: z.array(z.string()),
      account_services: z.array(z.string()),
    })),
    total: z.number().int(),
    next_offset: z.number().int().nullable(),
  }),
  annotations: READ_ONLY_ANNOTATIONS,
  async handler({ offset = 0 }, ctx) {
    const visible = await listVisibleAgents(xAgentCallerFor(ctx))
    if (!visible.ok) throw new McpToolError(visible.error)
    const withStatus = new Map((await listAgentsWithStatus()).map((agent) => [agent.displaySlug, agent]))
    const agents = visible.value.agents.map((agent) => {
      const listed = withStatus.get(agent.slug)
      return {
        slug: agent.slug,
        name: agent.name,
        description: agent.description ? truncateText(agent.description, DESCRIPTION_MAX_CHARS).text : null,
        status: listed?.status ?? 'stopped',
        team_brain: !!listed?.teamBrain,
        created_at: agent.createdAt.toISOString(),
        members: agent.members,
        member_count: agent.memberCount,
        session_running: agent.running,
        needs_input: agent.needsInput,
        last_activity_at: agent.lastActivityAt?.toISOString() ?? null,
        session_count: agent.sessionCount,
        automated_session_count: agent.automatedSessionCount,
        dashboards: agent.dashboards,
        account_services: agent.accountServices,
      }
    })
    const page = agents.slice(offset, offset + AGENTS_PAGE_SIZE)
    const fitting = countFitting(page, MAX_RESULT_CHARS - 1_000)
    const end = offset + fitting
    return { agents: page.slice(0, fitting), total: agents.length, next_offset: end < agents.length ? end : null }
  },
})

export const agentTools = [listAgents] as const
