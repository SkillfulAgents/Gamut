import { z } from 'zod'

/** The portable subset of the SDK's agent-<id>.meta.json. Older sidecars may only name a tool. */
export const subagentMetadataSchema = z.object({
  toolUseId: z.string().optional(),
  agentType: z.string().optional(),
  description: z.string().optional(),
  finished: z.boolean().optional(),
  stoppedByUser: z.boolean().optional(),
})
export const subagentRefSchema = subagentMetadataSchema.extend({ id: z.string() })
export type SubagentRef = z.infer<typeof subagentRefSchema>
