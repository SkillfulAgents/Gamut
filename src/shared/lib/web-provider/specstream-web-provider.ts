import type { ApiKeySettings } from '../config/settings'
import { APP_VERSION } from '../config/version'
import { isUrlAllowed } from './allowed-sites'
import { BaseWebProvider, type WebProviderSettings } from './base-web-provider'
import { SpecStreamExtractResponseSchema, SpecStreamSearchResponseSchema } from './specstream-response-schema'
import type {
  WebFetchOptions,
  WebFetchResult,
  WebProviderId,
  WebSearchHit,
  WebSearchOptions,
  WebSearchResponse,
} from './types'

const SEARCH_URL = 'https://api.specstream.ai/v1/web-search'
const EXTRACT_URL = 'https://api.specstream.ai/v1/extract'
const USER_AGENT = `Gamut/${APP_VERSION}`
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000

/** `*.python.org` and `python.org` both become `site:python.org`, which also covers subdomains. */
function bareDomain(domain: string): string {
  return domain.replace(/^\*\./, '')
}

/**
 * Domain filters travel in the query as `site:` operators (the API has no separate field), so the
 * vendor searches inside the requested sites instead of the host discarding hits afterwards.
 */
export function buildSpecStreamQuery(query: string, opts: WebSearchOptions): string {
  const include = [...new Set((opts.includeDomains ?? []).map(bareDomain))]
  const exclude = [...new Set((opts.excludeDomains ?? []).map(bareDomain))]
  const parts = [query]
  if (include.length === 1) parts.push(`site:${include[0]}`)
  if (include.length > 1) parts.push(`(${include.map((d) => `site:${d}`).join(' OR ')})`)
  for (const d of exclude) parts.push(`-site:${d}`)
  return parts.join(' ')
}

function dateBounds(opts: WebSearchOptions): { start?: number; end?: number } {
  const start = opts.startPublishedDate ? Date.parse(opts.startPublishedDate) : undefined
  const end = opts.endPublishedDate
    ? Date.parse(opts.endPublishedDate) + (DATE_ONLY.test(opts.endPublishedDate) ? DAY_MS - 1 : 0)
    : undefined
  if ((start !== undefined && !Number.isFinite(start)) || (end !== undefined && !Number.isFinite(end))
    || (start !== undefined && end !== undefined && start > end)) {
    throw new Error('Invalid SpecStream search publication date filter')
  }
  return { start, end }
}

/**
 * Map GET /v1/web-search into normalized hits. The requested domains and dates are enforced again
 * on the returned links (the API has no date filter); hits without a stated publication date are
 * kept, as for You.com.
 */
export function mapSpecStreamSearchResponse(raw: unknown, opts: WebSearchOptions, count: number): WebSearchResponse {
  const { start, end } = dateBounds(opts)
  const parsed = SpecStreamSearchResponseSchema.parse(raw)
  const hits: WebSearchHit[] = parsed.data.sources.map((s) => {
    const published = s.published ? Date.parse(s.published) : NaN
    return {
      url: s.url,
      title: s.title ?? null,
      snippet: s.snippet ?? '',
      ...(Number.isFinite(published) ? { publishedDate: new Date(published).toISOString() } : {}),
    }
  })
  const sitePolicy = {
    allowedSites: opts.includeDomains?.flatMap((d) => (d.startsWith('*.') ? [d] : [d, `*.${d}`])),
    blockedSites: opts.excludeDomains?.flatMap((d) => (d.startsWith('*.') ? [d] : [d, `*.${d}`])),
  }
  const filtered = hits.filter((hit) => {
    if (!isUrlAllowed(hit.url, sitePolicy)) return false
    const published = hit.publishedDate ? Date.parse(hit.publishedDate) : NaN
    if (!Number.isFinite(published)) return true
    return (start === undefined || published >= start) && (end === undefined || published <= end)
  })
  const warnings = filtered.length < hits.length
    ? ['Results outside the requested domain or publication date filters were removed.']
    : []
  return { hits: filtered.slice(0, count), ...(warnings.length ? { warnings } : {}) }
}

/**
 * Map POST /v1/extract (one URL) into a normalized document. Only a live read counts: a page the
 * API could not read, or could serve only from an archived copy, is a whole-request failure, so an
 * agent never quotes an older capture as the page today.
 */
export function mapSpecStreamExtractResponse(raw: unknown, maxChars: number | undefined, fetchedAt: string): WebFetchResult {
  const first = SpecStreamExtractResponseSchema.parse(raw).data.results[0]
  if (!first) throw new Error('SpecStream returned no result for the requested URL')
  if (first.status !== 'ok') throw new Error(`SpecStream could not read the page (${first.status})`)
  if (first.read_from === 'archive') throw new Error('SpecStream could only serve an archived copy of the page')
  const text = first.text ?? ''
  const published = first.published ? Date.parse(first.published) : NaN
  return {
    url: first.url,
    title: first.title ?? null,
    content: maxChars != null ? text.slice(0, maxChars) : text,
    ...(Number.isFinite(published) ? { publishedDate: new Date(published).toISOString() } : {}),
    fetchedAt,
  }
}

/** SpecStream Search API (search) and Extract API (fetch) on one key. */
export class SpecStreamWebProvider extends BaseWebProvider {
  readonly id: WebProviderId = 'specstream'
  readonly name = 'SpecStream'
  protected readonly settingsKeyField: keyof ApiKeySettings = 'specstreamApiKey'
  protected readonly envVarName = 'SPECSTREAM_API_KEY'

  async search(query: string, opts: WebSearchOptions, settings?: WebProviderSettings): Promise<WebSearchResponse> {
    const apiKey = await this.apiKeyFor(settings)
    if (!apiKey) throw new Error('SpecStream API key not configured')
    dateBounds(opts) // reject a bad filter before a billed call
    const count = this.clampNumResults(opts.numResults)
    const params = new URLSearchParams({ q: buildSpecStreamQuery(query, opts), num: String(count) })
    const json = await this.fetchJson(`${SEARCH_URL}?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
    })
    return mapSpecStreamSearchResponse(json, opts, count)
  }

  async fetch(url: string, opts: WebFetchOptions, settings?: WebProviderSettings): Promise<WebFetchResult> {
    const apiKey = await this.apiKeyFor(settings)
    if (!apiKey) throw new Error('SpecStream API key not configured')
    const json = await this.fetchJson(EXTRACT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ urls: [url], format: 'markdown' }),
    })
    return mapSpecStreamExtractResponse(json, this.clampMaxChars(opts.maxChars), new Date().toISOString())
  }

  /**
   * A search with no `q` is refused before anything runs or is billed: 400 for an accepted key,
   * 401 for a refused one. So saving a key costs nothing.
   */
  async validateKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
    if (!apiKey.trim()) return { valid: false, error: 'API key is required' }
    return this.runValidation(async (signal) => {
      const res = await fetch(SEARCH_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal,
      })
      // runValidation treats ok as valid; a 400 here means the key passed and only `q` was missing.
      return res.status === 400 ? new Response(null, { status: 204 }) : res
    })
  }
}
