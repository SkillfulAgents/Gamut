import { readGlobalSelection } from '@shared/lib/llm-provider/connections'
import { Hono } from 'hono'
import { Authenticated } from '../middleware/auth'
import { containerHost, hasRunningAgents } from '@shared/lib/agent-actor'
import { APP_VERSION } from '@shared/lib/config/version'
import { activeLlmProviderFrom } from '@shared/lib/llm-provider'
import { getServicesInitError } from '@shared/lib/startup'

const runtimeStatus = new Hono()

runtimeStatus.use('*', Authenticated())

// GET /api/runtime-status - lightweight status check for all authenticated users.
// Polled by every window, so the settings and the shared connections are read
// together and nothing is read after them.
runtimeStatus.get('/', async (c) => {
  const { settings, root } = await readGlobalSelection()
  return c.json({
    runtimeReadiness: containerHost.getReadiness(),
    hasRunningAgents: await hasRunningAgents(),
    apiKeyConfigured: (root?.provider ?? activeLlmProviderFrom(settings)).apiKeyStatusFrom(settings).isConfigured,
    servicesInitError: getServicesInitError(),
    appVersion: APP_VERSION,
  })
})

export default runtimeStatus
