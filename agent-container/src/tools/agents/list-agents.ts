import { tool } from '@anthropic-ai/claude-agent-sdk'
import { callHost, textResult, XAgentError } from './host-client'
import { listAgentsResultSchema, type ListedAgent, type ListedSections } from './host-response-schemas'

export function makeListAgentsTool(getCallerSessionId: () => string) {
  return tool(
    'list_agents',
    `List the other agents in this workspace that you can interact with. Each entry gives the agent's slug, name and description, its members (people and agents, with their roles), when it was created, whether it is running or needs input, when it was last active, its session count, its dashboards, and the services it has accounts for.

When a person is behind this session (the latest person who wrote in it, or the app's one user when sign-in is off), the agents are grouped under that person's sidebar sections, in their sidebar's order. Sections are the person's own way of organizing agents in the app's left nav. With no person known, the list is flat.

Use this before invoke_agent to discover available agents. The list excludes yourself.

In auth mode, the list is filtered to agents the workspace owner has access to.`,
    {},
    async () => {
      try {
        const data = await callHost('list', {}, listAgentsResultSchema, { callerSessionId: getCallerSessionId() })
        if (data.agents.length === 0) {
          return textResult('No other agents available in this workspace.')
        }
        return textResult(formatAgentList(data.agents, data.sections))
      } catch (error) {
        const msg = error instanceof XAgentError ? error.message : String(error)
        return textResult(`Failed to list agents: ${msg}`, true)
      }
    },
  )
}

export function formatAgentList(agents: ListedAgent[], sections?: ListedSections): string {
  const list = `Available agents (${agents.length}):`
  if (!sections) return `${list}\n${agents.map(formatAgentEntry).join('\n')}`
  const bySlug = new Map(agents.map((a) => [a.slug, a]))
  const blocks = sections.sections.map(({ name, agents: slugs }) => {
    const entries = slugs.flatMap((slug) => bySlug.get(slug) ?? []).map(formatAgentEntry)
    return `## ${name}\n${entries.length ? entries.join('\n') : '(no agents listed here)'}`
  })
  const owner = sections.personName ? ` (for ${sections.personName})` : ''
  return `${list}\nYour sidebar sections${owner}:\n${blocks.join('\n')}`
}

export function formatAgentEntry(a: ListedAgent): string {
  const lines = [`- ${a.slug} (${a.name})${a.description ? ` — ${a.description}` : ''}`]
  if (a.memberCount > 0) {
    const names = a.members.map((m) => {
      const tags = [m.kind === 'agent' && 'agent', m.role, m.invited && 'invited'].filter(Boolean).join(', ')
      return `${m.name} (${tags})`
    })
    const more = a.memberCount - a.members.length
    lines.push(`  Members (${a.memberCount}): ${names.join(', ')}${more > 0 ? `, +${more} more` : ''}`)
  }
  const sessions = `${a.sessionCount} session${a.sessionCount === 1 ? '' : 's'}${a.automatedSessionCount ? `, ${a.automatedSessionCount} automated` : ''}`
  lines.push(`  ${[
    `Created ${a.createdAt.slice(0, 10)}`,
    a.running && 'running now',
    a.needsInput && 'needs input',
    a.lastActivityAt && `last active ${a.lastActivityAt.slice(0, 10)}`,
    sessions,
  ].filter(Boolean).join(' · ')}`)
  if (a.dashboards.length) lines.push(`  Dashboards: ${a.dashboards.join(', ')}`)
  if (a.accountServices.length) lines.push(`  Accounts: ${a.accountServices.join(', ')}`)
  return lines.join('\n')
}
