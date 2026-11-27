import { z } from 'zod'

/** The cloud session an agent's browser is (live-session.ts). */
export const liveSessionSchema = z.object({ sessionId: z.string().min(1) })
