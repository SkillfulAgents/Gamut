import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.test',
}))

const mockGetPlatformAccessToken = vi.fn()
vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
}))

vi.mock('@shared/lib/db', () => {
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: () => chainable,
    orderBy: () => chainable,
    limit: () => chainable,
    all: () => [{ accountId: 'sub_alice' }],
  }
  return { db: chainable }
})

vi.mock('@shared/lib/db/schema', () => ({
  authAccount: { userId: 'u', providerId: 'p', accountId: 'a', updatedAt: 't' },
}))

vi.mock('drizzle-orm', () => ({ eq: () => '=', and: () => '&', desc: () => 'DESC' }))

const mockAgentRecord = vi.fn()
vi.mock('@shared/lib/agent-actor/agent-catalog', () => ({
  agentCatalog: { get: (slug: string) => mockAgentRecord(slug) },
}))

import { runOutsideAttribution, runWithRequestUser } from './index'
import { runWithAgent } from './request-context'
import {
  _uninstallPlatformFetchInterceptorForTest,
  installPlatformFetchInterceptor,
} from './install-fetch-interceptor'

const ORG_TOKEN = (() => {
  const header = Buffer.from('{"alg":"none"}').toString('base64url')
  const payload = Buffer.from(JSON.stringify({ orgId: 'org_42' })).toString('base64url')
  return `${header}.${payload}.sig`
})()

const realFetchMock = vi.fn()

beforeEach(() => {
  realFetchMock.mockReset()
  realFetchMock.mockResolvedValue(new Response(null, { status: 200 }))
  // Stub global fetch BEFORE installing the interceptor so the interceptor
  // wraps the stub. Tests that bypass the interceptor (set fetch directly)
  // would see their stub instead.
  globalThis.fetch = realFetchMock as unknown as typeof fetch
  installPlatformFetchInterceptor()
  mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
})

afterEach(() => {
  _uninstallPlatformFetchInterceptorForTest()
})

describe('installPlatformFetchInterceptor', () => {
  it('rewrites Authorization with the member-encoded bearer on platform-proxy URLs', async () => {
    await runWithRequestUser('user_alice', async () => {
      await fetch('https://proxy.test/v1/foo', { method: 'POST' })
    })
    expect(realFetchMock).toHaveBeenCalledTimes(1)
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
  })

  it('passes through non-proxy URLs unchanged', async () => {
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    const [url, init] = realFetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('is a no-op when no attribution scope is active', async () => {
    await fetch('https://proxy.test/v1/foo')
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('preserves caller-supplied headers and init fields', async () => {
    await runWithRequestUser('user_alice', async () => {
      await fetch('https://proxy.test/v1/foo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-custom': '1' },
        body: '{"k":1}',
      })
    })
    const [, init] = realFetchMock.mock.calls[0]
    const headers = new Headers((init as RequestInit).headers)
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe('{"k":1}')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-custom')).toBe('1')
    expect(headers.get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
  })

  it('is idempotent — second install call does nothing', async () => {
    installPlatformFetchInterceptor()
    installPlatformFetchInterceptor()
    await runWithRequestUser('user_alice', async () => {
      await fetch('https://proxy.test/v1/foo')
    })
    // Wrapping twice would have called realFetchMock twice; assert single call.
    expect(realFetchMock).toHaveBeenCalledTimes(1)
  })

  it('resolves the attribution once per request, however many platform calls it makes', async () => {
    const resolutionsFor = async (calls: number) => {
      mockGetPlatformAccessToken.mockClear()
      await runWithRequestUser('user_alice', async () => {
        await Promise.all(Array.from({ length: calls }, () => fetch('https://proxy.test/v1/foo')))
        await fetch('https://proxy.test/v1/bar')
      })
      return mockGetPlatformAccessToken.mock.calls.length
    }

    expect(await resolutionsFor(1)).toBe(1)
    expect(await resolutionsFor(8)).toBe(1)
    for (const [, init] of realFetchMock.mock.calls) {
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
    }
  })
})

describe('agent on platform calls', () => {
  const sent = () => new Headers((realFetchMock.mock.calls[0][1] as RequestInit).headers)

  beforeEach(() => {
    mockAgentRecord.mockReset()
    mockAgentRecord.mockResolvedValue({ slug: 'abc', name: 'Analytics Tzar 📊' })
  })

  it('sends the agent and its name from the agent list, beside the attribution', async () => {
    await runWithRequestUser('user_alice', () => runWithAgent('abc', () => fetch('https://proxy.test/v1/exa/search')))
    expect(sent().get('X-Superagent-Agent-Id')).toBe('abc')
    expect(sent().get('X-Superagent-Agent-Name')).toBe(encodeURIComponent('Analytics Tzar 📊'))
    expect(sent().get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
  })

  it('replaces agent headers a caller passed, and drops them when no agent is in scope', async () => {
    const forged = { 'x-superagent-agent-id': 'evil', 'X-Superagent-Agent-Name': 'Evil' }
    await runWithAgent('abc', () => fetch('https://proxy.test/v1/exa/search', { headers: forged }))
    await fetch('https://proxy.test/v1/exa/search', { headers: { ...forged, Authorization: 'Bearer own-key', 'X-Other': 'kept' } })
    expect(sent().get('X-Superagent-Agent-Id')).toBe('abc')
    expect(sent().get('X-Superagent-Agent-Name')).toBe(encodeURIComponent('Analytics Tzar 📊'))
    const unscoped = new Headers((realFetchMock.mock.calls[1][1] as RequestInit).headers)
    expect(unscoped.get('X-Superagent-Agent-Id')).toBeNull()
    expect(unscoped.get('X-Superagent-Agent-Name')).toBeNull()
    expect(unscoped.get('Authorization')).toBe('Bearer own-key')
    expect(unscoped.get('X-Other')).toBe('kept')
  })

  it('leaves an opaque access key as the caller set it, and still sends the agent', async () => {
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')
    await runWithRequestUser('user_alice', () => runWithAgent('abc', () => fetch('https://proxy.test/v1/exa/search', { headers: { Authorization: 'Bearer recall-owner-key' } })))
    expect(sent().get('Authorization')).toBe('Bearer recall-owner-key')
    expect(sent().get('X-Superagent-Agent-Id')).toBe('abc')
  })

  it('cleans the name the way the container does', async () => {
    mockAgentRecord.mockResolvedValue({ slug: 'abc', name: 'Sales\n  Bot' })
    await runWithAgent('abc', () => fetch('https://proxy.test/v1/exa/search'))
    expect(sent().get('X-Superagent-Agent-Name')).toBe('Sales%20Bot')
  })

  it('rewrites a scoped org call to the acting member and leaves a detached call its own bearer, agent or not', async () => {
    await runWithRequestUser('user_alice', () => runWithAgent('abc', () => fetch('https://proxy.test/v1/recall', { headers: { Authorization: 'Bearer other' } })))
    await runWithRequestUser('user_alice', () => runWithAgent('abc', () => runOutsideAttribution(() => fetch('https://proxy.test/v1/webhook-events', { headers: { Authorization: 'Bearer relay::m1' } }))))
    expect(sent().get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
    expect(sent().get('X-Superagent-Agent-Id')).toBe('abc')
    const detached = new Headers((realFetchMock.mock.calls[1][1] as RequestInit).headers)
    expect(detached.get('Authorization')).toBe('Bearer relay::m1')
    expect(detached.get('X-Superagent-Agent-Id')).toBeNull()
  })

  it('follows the token in use, not the one at install', async () => {
    mockGetPlatformAccessToken.mockReturnValue('plat_sa_opaque_key')
    await runWithRequestUser('user_alice', () => fetch('https://proxy.test/v1/exa/search', { headers: { Authorization: 'Bearer own-key' } }))
    mockGetPlatformAccessToken.mockReturnValue(ORG_TOKEN)
    await runWithRequestUser('user_alice', () => fetch('https://proxy.test/v1/exa/search', { headers: { Authorization: 'Bearer own-key' } }))
    expect(sent().get('Authorization')).toBe('Bearer own-key')
    expect(new Headers((realFetchMock.mock.calls[1][1] as RequestInit).headers).get('Authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_alice`)
  })

  it('tags the inner agent when scopes nest, and none outside attribution', async () => {
    await runWithAgent('a', () => runWithAgent('b', () => fetch('https://proxy.test/v1/messages')))
    await runWithAgent('a', () => runOutsideAttribution(() => fetch('https://proxy.test/v1/messages')))
    expect(sent().get('X-Superagent-Agent-Id')).toBe('b')
    expect(new Headers((realFetchMock.mock.calls[1][1] as RequestInit).headers).get('X-Superagent-Agent-Id')).toBeNull()
  })

  it.each([['fails', () => mockAgentRecord.mockRejectedValue(new Error('db down'))], ['finds no agent', () => mockAgentRecord.mockResolvedValue(null)]])(
    'sends the id alone when the name lookup %s, and the call still goes out', async (_case, arrange) => {
      arrange()
      await runWithAgent('abc', () => fetch('https://proxy.test/v1/exa/search'))
      expect(sent().get('X-Superagent-Agent-Id')).toBe('abc')
      expect(sent().get('X-Superagent-Agent-Name')).toBeNull()
    })

  it('leaves calls to other hosts alone', async () => {
    await runWithAgent('abc', () => fetch('https://example.com/x'))
    expect(realFetchMock.mock.calls[0][1]).toBeUndefined()
  })
})
