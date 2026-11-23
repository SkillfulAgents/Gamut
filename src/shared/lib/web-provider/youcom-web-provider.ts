import type { ApiKeySettings } from '../config/settings'
import { APP_VERSION } from '../config/version'
import { parseMcpResponse } from '../mcp/discover-tools'
import { isUrlAllowed } from './allowed-sites'
import { BaseWebProvider, type WebProviderSettings } from './base-web-provider'
import {
  YouComInitializeSchema,
  YouComRpcResponseSchema,
  YouComSearchResponseSchema,
  YouComToolResultSchema,
  YouComToolsSchema,
  type YouComWebHit,
} from './youcom-response-schema'
import type { WebProviderId, WebSearchHit, WebSearchOptions, WebSearchResponse } from './types'

const MCP_URL_FREE = 'https://api.you.com/mcp/free'
const MCP_URL_KEYED = 'https://api.you.com/mcp'
const TOOL_NAME = 'you-search'
const PROTOCOL_VERSION = '2025-03-26'
const USER_AGENT = `Gamut/${APP_VERSION}`
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** An agent-requested domain covers that host and its subdomains (`python.org` keeps `docs.python.org`). */
function withSubdomains(domains: string[] | undefined): string[] | undefined {
  return domains?.flatMap((domain) => (domain.startsWith('*.') ? [domain] : [domain, `*.${domain}`]))
}

function searchHit(hit: YouComWebHit, news: boolean): WebSearchHit {
  // News page_age is a UTC publication timestamp. Web page_age is an index date.
  const date = news && hit.page_age ? hit.page_age : undefined
  const timestamp = date && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(date) ? `${date}Z` : date
  const published = timestamp ? Date.parse(timestamp) : NaN
  return {
    url: hit.url,
    title: hit.title ?? null,
    snippet: hit.contents?.highlights?.join('\n\n') || hit.snippets?.join('\n\n') || hit.description || '',
    ...(Number.isFinite(published) ? { publishedDate: new Date(published).toISOString() } : {}),
  }
}

function dateBounds(opts: WebSearchOptions) {
  const start = opts.startPublishedDate ? Date.parse(opts.startPublishedDate) : undefined
  const end = opts.endPublishedDate
    ? Date.parse(opts.endPublishedDate) + (DATE_ONLY.test(opts.endPublishedDate) ? DAY_MS - 1 : 0)
    : undefined
  if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))
    || (start !== undefined && end !== undefined && start > end)) {
    throw new Error('Invalid You.com search publication date filter')
  }
  // MCP accepts a pair of UTC days. Keep the precise bounds for local filtering.
  const first = start === undefined ? '0001-01-01' : new Date(start).toISOString().slice(0, 10)
  const last = end === undefined ? '9999-12-31' : new Date(end).toISOString().slice(0, 10)
  return { start, end, freshness: start !== undefined || end !== undefined ? `${first}to${last}` : undefined }
}

/** Host-side You.com Search MCP adapter. */
export class YouComWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'youcom'
  readonly name = 'You.com'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'ydcApiKey'
  protected readonly envVarName = 'YDC_API_KEY'

  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    if (!apiKey.trim()) return { valid: false, error: 'API key is required' }
    try {
      // MCP initialization accepts invalid tokens. A search checks this key's search scope.
      await this.search('example.com', { numResults: 1 }, { apiKeys: { ydcApiKey: apiKey } })
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'You.com key validation failed' }
    }
  }

  async search(query: string, opts: WebSearchOptions, settings?: WebProviderSettings): Promise<WebSearchResponse> {
    const { start, end, freshness } = dateBounds(opts)
    const apiKey = await this.apiKeyFor(settings)
    const mcpUrl = apiKey ? MCP_URL_KEYED : MCP_URL_FREE
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': USER_AGENT,
    }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`

    let sessionId: string | null = null
    const rpc = async (id: number, method: string, params?: Record<string, unknown>) => {
      const raw = await this.fetchJson(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
      }, async (res) => {
        if (method === 'initialize') {
          sessionId = res.headers.get('Mcp-Session-Id')
          if (sessionId) headers['Mcp-Session-Id'] = sessionId
        }
        return parseMcpResponse(res)
      })
      const response = YouComRpcResponseSchema.parse(raw)
      if (response.id !== id) throw new Error('You.com returned a mismatched MCP response')
      if (response.error) throw new Error(`You.com MCP error (${response.error.code})`)
      return response.result
    }

    try {
      const initialized = YouComInitializeSchema.parse(await rpc(1, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Gamut', version: APP_VERSION },
      }))
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported You.com MCP protocol version')
      headers['MCP-Protocol-Version'] = PROTOCOL_VERSION
      await this.fetchJson(mcpUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }, async (res) => { await res.body?.cancel(); return undefined })
      const tools = YouComToolsSchema.parse(await rpc(2, 'tools/list'))
      if (!tools.tools.some((tool) => tool.name === TOOL_NAME)) {
        throw new Error('You.com MCP did not advertise you-search')
      }
      const count = this.clampNumResults(opts.numResults)
      // You.com accepts only one of include/exclude. In mixed requests, narrow the search
      // to the included domains, then apply both lists locally. A wildcard exclusion must
      // stay local because excluding its parent at You.com would also drop the apex.
      const includes = opts.includeDomains?.map(domain => domain.replace(/^\*\./, ''))
      const excludes = opts.excludeDomains?.filter(domain => !domain.startsWith('*.'))
      const toolResult = YouComToolResultSchema.parse(await rpc(3, 'tools/call', {
        name: TOOL_NAME,
        arguments: {
          query, count, extraction: 'highlights', freshness,
          ...(!includes?.length && excludes?.length ? { exclude_domains: excludes } : {}),
        },
        ...(includes?.length ? { _meta: { 'com.you.com/search': { include_domains: includes } } } : {}),
      }))
      if (toolResult.isError) {
        const denied = toolResult.content.some(part => /\berror code:\s*(401|403)\b/i.test(part.text ?? ''))
        throw new Error(denied ? 'You.com rejected the API key or its search permissions' : 'You.com MCP search failed')
      }
      const text = toolResult.content.find((part) => part.type === 'text' && part.text)?.text
      const parsed = YouComSearchResponseSchema.parse(
        toolResult.structuredContent ?? (text ? JSON.parse(text) : undefined),
      )
      const hits = [
        ...(parsed.results?.web ?? []).map(hit => searchHit(hit, false)),
        ...(parsed.results?.news ?? []).map(hit => searchHit(hit, true)),
      ]
      const warnings: string[] = []
      const sitePolicy = {
        allowedSites: withSubdomains(opts.includeDomains),
        blockedSites: withSubdomains(opts.excludeDomains),
      }
      const filtered = hits.filter((hit) => {
        if (!isUrlAllowed(hit.url, sitePolicy)) return false
        const published = hit.publishedDate ? Date.parse(hit.publishedDate) : NaN
        if (!Number.isFinite(published)) return true
        return (start === undefined || published >= start) && (end === undefined || published <= end)
      })
      if (filtered.length < hits.length) {
        warnings.push('Results outside the requested domain or publication date filters were removed.')
      }
      return { hits: filtered.slice(0, count), ...(warnings.length ? { warnings } : {}) }
    } finally {
      if (sessionId) {
        await this.fetchJson(mcpUrl, { method: 'DELETE', headers }, async (res) => {
          await res.body?.cancel(); return undefined
        }).catch(() => undefined)
      }
    }
  }
}
