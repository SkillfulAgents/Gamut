import { z } from 'zod'
import { contextBreakdownSchema } from '../../../../agent-container/src/context-breakdown-schema'
export { contextBreakdownSchema, type ContextBreakdown } from '../../../../agent-container/src/context-breakdown-schema'

export const contextBreakdownResponseSchema = z.object({
  breakdown: contextBreakdownSchema.nullable(),
  revision: z.string().optional(),
})
export type RuntimeContext = z.infer<typeof contextBreakdownResponseSchema>

export const savedContextSchema = z.object({
  kind: z.enum(['estimate', 'full']),
  revision: z.string(),
  measuredAt: z.iso.datetime(),
  breakdown: contextBreakdownSchema,
})
export type SavedContext = z.infer<typeof savedContextSchema>

export const sessionContextSchema = z.object({
  breakdown: contextBreakdownSchema.nullable(),
  source: z.enum(['live', 'saved-full', 'saved-estimate', 'saved-usage']).optional(),
  usage: z.object({ totalTokens: z.number(), contextWindow: z.number() }).optional(),
  capturedAt: z.iso.datetime().optional(),
  refreshFailed: z.boolean().optional(),
})
export type SessionContext = z.infer<typeof sessionContextSchema>
