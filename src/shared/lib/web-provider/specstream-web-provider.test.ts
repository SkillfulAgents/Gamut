import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: vi.fn(() => ({ apiKeys: { specstreamApiKey: 'test-key' } })),
}))

// Keep real retry logic but with zero backoff so retry behavior is exercised instantly.
vi.mock('@shared/lib/utils/retry', async (orig) => {
  const actual = await orig<typeof import('@shared/lib/utils/retry')>()
  return { ...actual, withRetry: (fn: () => Promise<unknown>, max?: number) => actual.withRetry(fn, max, 0) }
})

import { getSettings } from '@shared/lib/config/settings'
import {
  buildSpecStreamQuery,
  mapSpecStreamExtractResponse,
  mapSpecStreamSearchResponse,
  SpecStreamWebProvider,
} from './specstream-web-provider'

const AT = '2026-11-26T00:00:00.000Z'

function mockSettings(apiKeys: { specstreamApiKey?: string }) {
  vi.mocked(getSettings).mockReturnValue({ apiKeys } as unknown as ReturnType<typeof getSettings>)
}

function mockFetch(json: unknown, { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, status, statusText: ok ? 'OK' : 'Error', json: async () => json })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const search = (sources: unknown[]) => ({ data: { kind: 'fact', answer: { value: 'x' }, rows: [], sources } })
const extract = (result: Record<string, unknown>) => ({ data: { results: [{ url: 'https://example.com/doc', ...result }] } })

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.SPECSTREAM_API_KEY
  mockSettings({ specstreamApiKey: 'test-key' })
})

describe('buildSpecStreamQuery', () => {
  it('leaves a query without filters untouched', () => {
    expect(buildSpecStreamQuery('asyncio TaskGroup', {})).toBe('asyncio TaskGroup')
  })

  it('adds one site, an OR group for several, and a negated site per exclusion', () => {
    expect(buildSpecStreamQuery('q', { includeDomains: ['python.org'] })).toBe('q site:python.org')
    expect(buildSpecStreamQuery('q', { includeDomains: ['*.python.org', 'peps.python.org'], excludeDomains: ['stackoverflow.com'] }))
      .toBe('q (site:python.org OR site:peps.python.org) -site:stackoverflow.com')
  })
})

describe('mapSpecStreamSearchResponse', () => {
  it('maps data.sources and ignores answer and rows', () => {
    const res = mapSpecStreamSearchResponse(search([
      { url: 'https://docs.python.org/3/library/asyncio-task.html', title: 'Coroutines and Tasks', snippet: 'TaskGroup', published: '2025-02-04' },
      { url: 'https://example.com/b', title: null, snippet: null },
    ]), {}, 10)
    expect(res).toEqual({
      hits: [
        { url: 'https://docs.python.org/3/library/asyncio-task.html', title: 'Coroutines and Tasks', snippet: 'TaskGroup', publishedDate: '2025-02-04T00:00:00.000Z' },
        { url: 'https://example.com/b', title: null, snippet: '' },
      ],
    })
  })

  it('enforces domains and publication dates on the returned links, keeping undated hits', () => {
    const res = mapSpecStreamSearchResponse(search([
      { url: 'https://docs.python.org/a', title: 'in', snippet: 's', published: '2026-06-01' },
      { url: 'https://docs.python.org/old', title: 'old', snippet: 's', published: '2024-01-01' },
      { url: 'https://docs.python.org/undated', title: 'undated', snippet: 's' },
      { url: 'https://evil.example/x', title: 'out', snippet: 's' },
    ]), { includeDomains: ['python.org'], startPublishedDate: '2026-01-01', endPublishedDate: '2026-12-31' }, 10)
    expect(res.hits.map((h) => h.title)).toEqual(['in', 'undated'])
    expect(res.warnings).toEqual(['Results outside the requested domain or publication date filters were removed.'])
  })

  it('caps the hits at the requested count', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ url: `https://e.example/${i}`, title: `${i}`, snippet: 's' }))
    expect(mapSpecStreamSearchResponse(search(many), {}, 3).hits).toHaveLength(3)
  })

  it('rejects a malformed body and an inverted date range', () => {
    expect(() => mapSpecStreamSearchResponse({ results: [] }, {}, 10)).toThrow()
    expect(() => mapSpecStreamSearchResponse(search([]), { startPublishedDate: '2026-02-01', endPublishedDate: '2026-01-01' }, 10))
      .toThrow('Invalid SpecStream search publication date filter')
  })
})

describe('mapSpecStreamExtractResponse', () => {
  it('maps a live read and applies maxChars', () => {
    const res = mapSpecStreamExtractResponse(extract({ status: 'ok', title: 'Doc', text: 'abcdef', read_from: 'live', published: '2026-03-02' }), 3, AT)
    expect(res).toEqual({ url: 'https://example.com/doc', title: 'Doc', content: 'abc', publishedDate: '2026-03-02T00:00:00.000Z', fetchedAt: AT })
  })

  it('fails a page that was not read, naming the status', () => {
    for (const status of ['blocked', 'not_found', 'empty', 'unsupported', 'failed']) {
      expect(() => mapSpecStreamExtractResponse(extract({ status, text: '404 page text' }), undefined, AT))
        .toThrow(`SpecStream could not read the page (${status})`)
    }
  })

  it('fails a read served only from an archived copy', () => {
    expect(() => mapSpecStreamExtractResponse(extract({ status: 'ok', text: 'old', read_from: 'archive' }), undefined, AT))
      .toThrow('SpecStream could only serve an archived copy of the page')
  })

  it('fails an empty results list', () => {
    expect(() => mapSpecStreamExtractResponse({ data: { results: [] } }, undefined, AT)).toThrow('SpecStream returned no result')
  })
})

describe('SpecStreamWebProvider', () => {
  it('search sends GET /v1/web-search with q, num and a Bearer key', async () => {
    const fetchMock = mockFetch(search([{ url: 'https://docs.python.org/a', title: 'A', snippet: 's' }]))
    const res = await new SpecStreamWebProvider().search('asyncio TaskGroup', { numResults: 40, includeDomains: ['python.org'] })
    expect(res.hits).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    const sent = new URL(url as string)
    expect(sent.origin + sent.pathname).toBe('https://api.specstream.ai/v1/web-search')
    expect(sent.searchParams.get('q')).toBe('asyncio TaskGroup site:python.org')
    expect(sent.searchParams.get('num')).toBe('25') // host cap
    expect((init as RequestInit).method).toBe('GET')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('fetch sends POST /v1/extract with one URL in markdown', async () => {
    const fetchMock = mockFetch(extract({ status: 'ok', title: 'Doc', text: 'body', read_from: 'live' }))
    const res = await new SpecStreamWebProvider().fetch('https://example.com/doc', {})
    expect(res.content).toBe('body')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.specstream.ai/v1/extract')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ urls: ['https://example.com/doc'], format: 'markdown' })
  })

  it('uses SPECSTREAM_API_KEY when no key is saved, and the saved key first', async () => {
    mockSettings({})
    process.env.SPECSTREAM_API_KEY = 'env-key'
    const fetchMock = mockFetch(search([]))
    await new SpecStreamWebProvider().search('q', {})
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer env-key' })
    mockSettings({ specstreamApiKey: 'saved-key' })
    await new SpecStreamWebProvider().search('q', {})
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer saved-key' })
  })

  it('throws without a key and sends nothing', async () => {
    mockSettings({})
    const fetchMock = mockFetch(search([]))
    await expect(new SpecStreamWebProvider().search('q', {})).rejects.toThrow('SpecStream API key not configured')
    await expect(new SpecStreamWebProvider().fetch('https://example.com', {})).rejects.toThrow('SpecStream API key not configured')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not retry a 401', async () => {
    const fetchMock = mockFetch({}, { ok: false, status: 401 })
    await expect(new SpecStreamWebProvider().search('q', {})).rejects.toThrow('SpecStream request failed: 401')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('validateKey reads 400 (query missing, key accepted) as valid and 401 as invalid, with no query sent', async () => {
    const fetchMock = mockFetch({}, { ok: false, status: 400 })
    expect(await new SpecStreamWebProvider().validateKey('good')).toEqual({ valid: true })
    expect(new URL(fetchMock.mock.calls[0][0] as string).search).toBe('')
    mockFetch({}, { ok: false, status: 401 })
    expect(await new SpecStreamWebProvider().validateKey('bad')).toEqual({ valid: false, error: 'Invalid API key' })
    expect(await new SpecStreamWebProvider().validateKey('  ')).toEqual({ valid: false, error: 'API key is required' })
  })
})
