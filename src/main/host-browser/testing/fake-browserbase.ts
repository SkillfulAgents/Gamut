/**
 * A fake Browserbase for provider tests: an account that keeps its sessions
 * and a log of what was asked of it, served on `fetch` for the direct API and
 * for the platform proxy alike.
 *
 * It answers 200 to every release unless a test says otherwise. What the real
 * API answers for a session that already ended was not measured; a test that
 * depends on a refusal sets it itself.
 */
import { vi } from 'vitest'

function jsonObject(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface FakeRequest { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** A Browserbase account: its sessions, and a log of what was asked of it. */
export class FakeBrowserbase {
  sessions = new Map<string, string>()
  requests: FakeRequest[] = []
  created: string[] = []
  /** Sessions a release request named, accepted or not. */
  releaseAsked: string[] = []
  /** Sessions whose debug endpoint answers 500. */
  debugBroken = new Set<string>()
  /** Sessions whose read answers 500. */
  readBroken = new Set<string>()
  /** The next answers to a release: a status, or 'network' for a request that never gets through. Then 200. */
  releaseAnswers: Array<number | 'network'> = []
  createStatus = 200
  private made = 0
  private createsHeld: Array<() => void> | null = null

  running(): string[] {
    return [...this.sessions].filter(([, status]) => status === 'RUNNING').map(([id]) => id)
  }

  /** Holds every create until `resume`, so launches under way all read the record before any writes it. */
  holdCreates(): { waiting: () => number; resume: () => void } {
    const held: Array<() => void> = []
    this.createsHeld = held
    return {
      waiting: () => held.length,
      resume: () => {
        this.createsHeld = null
        for (const go of held) go()
      },
    }
  }

  readonly fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Both bases end in /v1, the proxy's in /v1/browserbase.
    const path = String(input).replace(/^https:\/\/[^/]+\/v1(\/browserbase)?/, '')
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? jsonObject(init.body) : null
    this.requests.push({ method, path, headers: { ...(init?.headers as Record<string, string>) }, body })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

    if (path === '/contexts' && method === 'POST') return json({ id: 'ctx-1' })
    if (path === '/sessions' && method === 'POST') {
      if (this.createsHeld) await new Promise<void>((resolve) => this.createsHeld!.push(resolve))
      if (this.createStatus !== 200) return json({ message: 'refused' }, this.createStatus)
      const id = `sess-${++this.made}`
      this.sessions.set(id, 'RUNNING')
      this.created.push(id)
      return json({ id, connectUrl: `wss://connect.test/${id}`, status: 'RUNNING', keepAlive: body?.keepAlive === true })
    }
    const debug = /^\/sessions\/([^/]+)\/debug$/.exec(path)
    if (debug && method === 'GET') {
      const id = debug[1]
      if (this.debugBroken.has(id) || this.sessions.get(id) !== 'RUNNING') return json({ message: 'no debugger' }, 500)
      return json({ wsUrl: `wss://debug.test/${id}`, pages: [{ id: 'page-1', url: 'https://example.com/', debuggerUrl: `https://live.test/inspector.html?wss=debug.test/${id}/page-1?t=signed` }] })
    }
    const one = /^\/sessions\/([^/]+)$/.exec(path)
    if (one && method === 'GET') {
      const id = one[1]
      if (this.readBroken.has(id)) return json({ message: 'try later' }, 500)
      const status = this.sessions.get(id)
      return status ? json({ id, status, connectUrl: `wss://connect.test/${id}`, keepAlive: true }) : json({ message: 'not found' }, 404)
    }
    if (one && method === 'POST' && body?.status === 'REQUEST_RELEASE') {
      const id = one[1]
      this.releaseAsked.push(id)
      const answer = this.releaseAnswers.shift() ?? 200
      if (answer === 'network') throw new TypeError('fetch failed')
      if (answer !== 200) return json({ message: 'refused' }, answer)
      this.sessions.set(id, 'COMPLETED')
      return json({ id, status: 'COMPLETED' })
    }
    return json({ message: `no route for ${method} ${path}` }, 404)
  })
}
