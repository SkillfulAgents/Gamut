import { describe, expect, it } from 'vitest'
import { withoutDefaultCache } from './request-cache'

/** A Request that refuses `cache: 'default'`, as the Workers one does. */
class WorkersRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.cache === 'default') throw new TypeError('Unsupported cache mode: default')
    super(input, init)
  }
}

describe('withoutDefaultCache', () => {
  const Patched = withoutDefaultCache(WorkersRequest)

  it('makes a request that names the default cache mode, and keeps every other option', async () => {
    expect(() => new WorkersRequest('https://slack.com/api/auth.test', { cache: 'default' })).toThrow('Unsupported cache mode')
    const request = new Patched('https://slack.com/api/auth.test', { method: 'POST', cache: 'default', body: 'a=1', headers: { 'x-test': '1' } })
    expect(request.method).toBe('POST')
    expect(request.headers.get('x-test')).toBe('1')
    expect(await request.text()).toBe('a=1')
  })

  it('leaves another cache mode to the runtime', () => {
    expect(new Patched('https://example.com', { cache: 'no-store' }).cache).toBe('no-store')
  })

  it('counts a request the runtime made as a Request', () => {
    expect(new WorkersRequest('https://example.com') instanceof Patched).toBe(true)
    expect(new Patched('https://example.com') instanceof Patched).toBe(true)
    expect({} instanceof Patched).toBe(false)
  })
})
