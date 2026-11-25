import { z } from 'zod';

/** Who sent a message. The host types its sends against this schema. */
const messageSenderSchema = z.object({
  /** The user id, agent slug, or task or trigger id. Absent for a person reached through an integration. */
  id: z.string().optional(),
  /** Absent where none is known (local mode's one person). */
  name: z.string().optional(),
  /** The person's role on the agent, when the sender is a member. */
  role: z.enum(['owner', 'user', 'viewer']).optional(),
  type: z.enum(['human', 'agent', 'automated']),
});

/**
 * What the host sends with a message: who sent it, where, and what started
 * the session. Partial: the container merges it onto the session's context.
 * Advisory: who is billed or attributed is decided on the host.
 */
export const messageContextSchema = z.object({
  /** What started the session, re-sent with every message. */
  session_trigger: z.enum(['user', 'scheduled', 'webhook', 'integration', 'agent', 'mcp', 'widget-repair']).optional(),
  sender: messageSenderSchema.optional(),
  /** Where the conversation happens: `ui`, or the integration's provider. */
  channel: z.enum(['ui', 'telegram', 'slack', 'imessage', 'linear', 'platform-email', 'recall', 'github']).optional(),
}).optional();

export type MessageSender = z.infer<typeof messageSenderSchema>;
export type MessageContext = z.infer<typeof messageContextSchema>;
export type SessionContext = NonNullable<MessageContext>;

/** A message's fields replace the session's. A stored context that no longer parses is dropped, not carried. */
export function mergeSessionContext(stored: unknown, incoming: MessageContext): SessionContext | undefined {
  const kept = messageContextSchema.safeParse(stored);
  const base = kept.success ? kept.data : undefined;
  if (!incoming) return base;
  return { ...base, ...incoming };
}
