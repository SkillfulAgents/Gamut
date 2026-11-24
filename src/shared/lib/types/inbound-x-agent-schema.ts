import { z } from 'zod'

export const inboundXAgentCallerSchema = z.object({
  slug: z.string(),
  displaySlug: z.string(),
  name: z.string(),
  decision: z.enum(['allow', 'review']),
  canAccess: z.boolean(),
})

const inboundSessionBaseSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
})

export const inboundXAgentSessionSchema = z.union([
  inboundSessionBaseSchema.extend({
    isWidgetRepair: z.literal(true),
    widgetRepairSlug: z.string().optional(),
  }),
  inboundSessionBaseSchema.extend({
    // Optional so existing x-agent history payloads remain valid.
    isWidgetRepair: z.literal(false).optional(),
    triggeredBy: z.object({
      slug: z.string(),
      name: z.string(),
    }),
  }),
  // Started by a person through the MCP server, from another AI tool.
  inboundSessionBaseSchema.extend({
    isWidgetRepair: z.literal(false).optional(),
    mcp: z.object({
      /** What the client called itself; null when its protocol era does not say. */
      clientName: z.string().nullable(),
    }),
  }),
])

export const inboundXAgentDetailsSchema = z.object({
  sessions: z.array(inboundXAgentSessionSchema),
  callers: z.array(inboundXAgentCallerSchema),
})

export type InboundXAgentCaller = z.infer<typeof inboundXAgentCallerSchema>
export type InboundXAgentSession = z.infer<typeof inboundXAgentSessionSchema>
export type InboundXAgentDetails = z.infer<typeof inboundXAgentDetailsSchema>
