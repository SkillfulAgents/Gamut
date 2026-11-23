import { z } from 'zod'

export const xAgentErrorResponseSchema = z.object({
  error: z.string().optional(),
})

export const listAgentsResultSchema = z.object({
  agents: z.array(z.object({
    slug: z.string(),
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.string(),
    members: z.array(z.object({
      name: z.string(),
      role: z.string(),
      kind: z.enum(['person', 'agent']),
      invited: z.literal(true).optional(),
    })),
    memberCount: z.number().int().nonnegative(),
    running: z.boolean(),
    needsInput: z.boolean(),
    lastActivityAt: z.string().nullable(),
    sessionCount: z.number().int().nonnegative(),
    automatedSessionCount: z.number().int().nonnegative(),
    dashboards: z.array(z.string()),
    accountServices: z.array(z.string()),
  })),
})

export type ListedAgent = z.infer<typeof listAgentsResultSchema>['agents'][number]

export const listAgentMembersResultSchema = z.object({
  truncated: z.boolean(),
  members: z.array(z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    invited: z.literal(true).optional(),
  })),
})

export const createAgentResultSchema = z.object({
  slug: z.string(),
  name: z.string(),
})

export const invokeResultSchema = z.object({
  sessionId: z.string(),
  status: z.enum(['running', 'completed']),
  lastMessage: z.string().optional(),
  error: z.string().optional(),
})

export const getSessionsResultSchema = z.object({
  sessions: z.array(z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    isRunning: z.boolean(),
  })),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
})

export const deliveredFileSchema = z.object({
  deliveryId: z.string(),
  filename: z.string(),
  description: z.string().optional(),
  sizeBytes: z.number().int().nonnegative(),
})

export const transcriptResultSchema = z.object({
  status: z.enum(['running', 'idle', 'awaiting_input']),
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
    toolName: z.string().optional(),
  })),
  total: z.number().int().nonnegative(),
  deliveredFiles: z.array(deliveredFileSchema).default([]),
})

export type InvokeResult = z.infer<typeof invokeResultSchema>
export type TranscriptResult = z.infer<typeof transcriptResultSchema>
