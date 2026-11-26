/**
 * Workers' Request refuses `cache: 'default'` ("Unsupported cache mode"), which axios, the Slack
 * SDK's HTTP client, sets on every request. It names the default, so the request is made without it.
 */
export function withoutDefaultCache(Base: typeof Request): typeof Request {
  return class extends Base {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init?.cache === 'default' ? { ...init, cache: undefined } : init)
    }

    // A request the runtime made is still a Request to code that asks after this class.
    static [Symbol.hasInstance](value: unknown): boolean {
      return value instanceof Base
    }
  }
}
