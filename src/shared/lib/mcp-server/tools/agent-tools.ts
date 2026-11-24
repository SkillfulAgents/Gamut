/**
 * list_agents: the agents the person has a role on, through the x-agent
 * service with a user caller (its ACL filter), with the status the app's
 * agent list shows.
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
  description: 'The Gamut agents you have a role on: slug (pass it to list_sessions and read_session), name, description, status, and whether it is the Team Brain agent.',
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
      }
    })
    const page = agents.slice(offset, offset + AGENTS_PAGE_SIZE)
    const fitting = countFitting(page, MAX_RESULT_CHARS - 1_000)
    const end = offset + fitting
    return { agents: page.slice(0, fitting), total: agents.length, next_offset: end < agents.length ? end : null }
  },
})

export const agentTools = [listAgents] as const
