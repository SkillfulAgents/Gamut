import { z } from 'zod'

/** The most grants one session keeps; past it the oldest are dropped. */
export const MAX_SESSION_GRANTS = 200

/** One "Allow for this session": a scope (API) or a tool (MCP) on one account or MCP server. */
export const sessionGrantSchema = z.object({
  kind: z.enum(['api', 'mcp']),
  /** The connected account's id, or the MCP server's. */
  targetId: z.string().min(1),
  /** An API scope the request matched, or the MCP tool's name. */
  scope: z.string().min(1),
})

export const sessionGrantsRecordSchema = z.object({
  grants: z.array(sessionGrantSchema).max(MAX_SESSION_GRANTS),
})

export type SessionGrant = z.infer<typeof sessionGrantSchema>
export type SessionGrantsRecord = z.infer<typeof sessionGrantsRecordSchema>
