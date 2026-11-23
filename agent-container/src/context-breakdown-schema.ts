import { z } from 'zod'

/**
 * Fields the Context tab displays from an SDK summary or full measurement.
 * Both include category rows and their supporting tools, files and skills.
 */
export const contextBreakdownSchema = z.object({
  /** Which row this is; a later CLI may add ids, so an unknown one is drawn by name. */
  categories: z.array(z.object({
    id: z.string().optional(),
    name: z.string(),
    tokens: z.number(),
    /** 'used' fills the window, 'free' is what is left, 'buffer' the compaction reserve, 'deferred' sits outside it. */
    kind: z.string(),
  })),
  totalTokens: z.number(),
  /** The model's whole window. */
  rawMaxTokens: z.number(),
  percentage: z.number(),
  model: z.string().optional(),
  memoryFiles: z.array(z.object({ path: z.string(), tokens: z.number() })).default([]),
  mcpTools: z.array(z.object({ name: z.string(), serverName: z.string(), tokens: z.number(), isLoaded: z.boolean().optional() })).default([]),
  skills: z.object({
    totalSkills: z.number(),
    includedSkills: z.number(),
    tokens: z.number(),
    skillFrontmatter: z.array(z.object({ name: z.string(), tokens: z.number() })).default([]),
  }).optional(),
  /** Where auto-compact starts, in tokens, when it is on. */
  autoCompactThreshold: z.number().optional(),
  isAutoCompactEnabled: z.boolean().optional(),
})

export type ContextBreakdown = z.infer<typeof contextBreakdownSchema>
