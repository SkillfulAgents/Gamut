import { CredentialRefreshError } from '../../../agent-container/src/credential-refresh-error'
import { resolveConnectionCredential } from '@shared/lib/llm-provider/connection-credentials'
import { Hono } from 'hono'
import { z } from 'zod'
import { IsAgent } from '../middleware/auth'
import { agentRegistry } from '@shared/lib/agent-actor'
import { resolveSelectionHierarchyFrom, storedSelection } from '@shared/lib/llm-provider/connections'
import {
  connectionRuntime,
} from '@shared/lib/llm-provider/connection-runtime'
import { getSettings } from '@shared/lib/config/settings'

const routes = new Hono()
routes.use('*', IsAgent())
routes.onError((error, c) => {
  if (!(error instanceof CredentialRefreshError)) throw error
  if (error.status === 503) c.header('Retry-After', '30')
  return c.json({ error: error.message, code: error.status === 401 ? 'provider_reconnect_required' : 'provider_refresh_unavailable' }, error.status)
})
const requestSchema = z.object({
  sessionId: z.string().min(1),
  llmProviderId: z.string().optional(),
  rejectedGeneration: z.number().int().optional(),
})
/** A settled read's value, or its failure thrown where the read used to be awaited. */
function valueOf<T>(read: PromiseSettledResult<T>): T {
  if (read.status === 'rejected') throw read.reason
  return read.value
}
routes.post('/resolve', async (c) => {
  const parsed = requestSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: 'Invalid credential request' }, 400)
  const input = parsed.data
  const slug = c.get('agentSlug' as never) as string
  const actor = agentRegistry.get(slug)
  // The four reads do not depend on each other, so they are in flight together:
  // where each is a round trip, the callback waits for one, not four. Their
  // outcomes are then taken in the order the reads used to run, so an unknown
  // session is still a 404 whatever the other reads did, and the first failure
  // in that order is still the one reported.
  const [known, metadataRead, preferencesRead, settingsRead] = await Promise.allSettled([
    actor.sessions.isKnown(input.sessionId),
    actor.sessions.metadata(input.sessionId),
    actor.config.get('preferences'),
    // One settings read per callback: the selection and the runtime use it.
    getSettings(),
  ])
  if (!valueOf(known)) return c.json({ error: 'Session not found' }, 404)
  const metadata = valueOf(metadataRead)
  const preferences = valueOf(preferencesRead)
  const settings = valueOf(settingsRead)
  const selected = await resolveSelectionHierarchyFrom(
    settings,
    await storedSelection(metadata?.model, metadata?.llmProviderId, settings),
    await storedSelection(preferences?.defaultModel, preferences?.defaultLlmProviderId, settings)
  )
  // The caller cannot nominate another connection. The app resolves the
  // authenticated agent's current session binding on every callback.
  c.header('Cache-Control', 'no-store')
  if (input.llmProviderId && input.llmProviderId !== selected.llmProviderId)
    return c.json({ error: 'Session connection changed' }, 409)
  if (input.rejectedGeneration !== undefined) await resolveConnectionCredential(selected.llmProviderId, input.rejectedGeneration)
  const runtime = await connectionRuntime(selected, slug, settings)
  // The session's errors and analytics are read with it: only its non-secret facts.
  await actor.sessions.recordRuntime(input.sessionId, { provider: runtime.provider })
  return c.json(runtime)
})
// Boot prewarming is bound to the authenticated agent's default. The container
// cannot use this endpoint to choose an arbitrary personal provider.
routes.post('/prewarm', async (c) => {
  const slug = c.get('agentSlug' as never) as string
  const preferences = await agentRegistry.get(slug).config.get('preferences')
  const settings = await getSettings()
  const selected = await resolveSelectionHierarchyFrom(
    settings,
    await storedSelection(preferences?.defaultModel, preferences?.defaultLlmProviderId, settings),
  )
  c.header('Cache-Control', 'no-store')
  return c.json(await connectionRuntime(selected, slug, settings))
})
export default routes
