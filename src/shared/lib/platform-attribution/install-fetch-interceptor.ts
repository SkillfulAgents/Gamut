import { getPlatformProxyBaseUrl } from '@shared/lib/platform-auth/config'
import { AGENT_ID_HEADER, AGENT_NAME_HEADER, agentAttributionHeaders } from '../../../../agent-container/src/attribution-headers'

import { attribution } from './index'
import { currentAgentSlug } from './request-context'

/**
 * Replace any agent headers on a platform call with the agent whose work this
 * is, and its name from the agent list. Agent headers a caller passed are
 * dropped even with no agent in scope, so only the app names an agent. A
 * missing or failed name lookup sends the id alone.
 */
async function applyAgentAttribution(headers: Headers, agentSlug: string | null): Promise<void> {
  headers.delete(AGENT_ID_HEADER)
  headers.delete(AGENT_NAME_HEADER)
  if (!agentSlug) return
  // Imported on first use so the catalog module, and everything it imports,
  // stays out of this hook's import graph: the hook loads with every platform call site.
  // The name is cleaned the way the container cleans its own, so one agent sends one name.
  const agentName = await Promise.all([import('@shared/lib/agent-actor/agent-catalog'), import('@shared/lib/llm-provider/platform-provider')])
    .then(async ([{ agentCatalog }, { sanitizeAgentName }]) => sanitizeAgentName((await agentCatalog.get(agentSlug))?.name ?? ''))
    .catch(() => undefined)
  for (const [name, value] of agentAttributionHeaders(agentSlug, agentName)) headers.set(name, value)
}

let installed = false
let realFetch: typeof globalThis.fetch | null = null

/** Wrap `globalThis.fetch` so platform-proxy requests pick up active attribution from ALS. Idempotent. */
export function installPlatformFetchInterceptor(): void {
  if (installed) return
  installed = true
  realFetch = globalThis.fetch.bind(globalThis)

  const debug = process.env.DEBUG_PLATFORM_API === '1'

  globalThis.fetch = async function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    const proxyBase = getPlatformProxyBaseUrl()
    if (proxyBase && url.startsWith(proxyBase)) {
      const headers = new Headers(init?.headers)
      // Only an org token carries an acting member. An opaque access key goes out as the caller set it.
      const auth = await attribution.current()
      if (auth?.actingMemberId()) auth.applyTo(headers)
      await applyAgentAttribution(headers, currentAgentSlug())
      if (debug) {
        const t0 = Date.now()
        const method = init?.method ?? 'GET'
        const res = await realFetch!(input, { ...init, headers })
        console.log(
          `[platform-fetch] ${method} ${url} -> ${res.status} (${Date.now() - t0}ms)`
        )
        return res
      }
      return realFetch!(input, { ...init, headers })
    }

    return realFetch!(input, init)
  } as typeof fetch
}

/** Test-only: undo the interceptor and reset its singleton state. */
export function _uninstallPlatformFetchInterceptorForTest(): void {
  if (!installed) return
  if (realFetch) globalThis.fetch = realFetch
  installed = false
  realFetch = null
}
