import { z } from 'zod'

// Keep in sync with sidebarFileSchema in src/shared/lib/services/x-agent/sidebar-sections.ts
const ROOT_ID = 'root'
const ROOT_NAME = 'Your Agents'

export const sidebarFileSchema = z.array(z.object({
  id: z.string().min(1).max(100),
  name: z.string(),
  agents: z.array(z.string().min(1)).max(1000),
})).max(200).superRefine((sections, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (sections.filter((s) => s.id === ROOT_ID).length !== 1) issue(`Exactly one section must have the id "${ROOT_ID}" (Your Agents).`)
  if (sections.some((s) => s.id === ROOT_ID && s.name !== ROOT_NAME)) issue(`The "${ROOT_ID}" section is always named "${ROOT_NAME}".`)
  if (new Set(sections.map((s) => s.id)).size !== sections.length) issue('Two sections share an id.')
  const agents = sections.flatMap((s) => s.agents)
  if (new Set(agents).size !== agents.length) issue('An agent is listed in more than one place.')
})
