import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import { BaseContainerClient } from './base-container-client'
import type { ContainerConfig, ContainerInfo, StreamMessage } from './types'

vi.mock('@shared/lib/container/host-token-store', () => ({
  getOrCreateHostToken: () => 'test-host-token',
}))
vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => ({ enableToolSearch: true }),
}))
vi.mock('@shared/lib/llm-provider', () => ({
  activeLlmProviderFrom: () => ({ getContainerEnvVars: () => ({}), toolSearchEnv: () => 'false' }),
}))

class Client extends BaseContainerClient {
  constructor(private readonly port: number) {
    super({ agentId: 'test-agent' } as ContainerConfig)
  }
  protected getRunnerCommand(): string {
    return 'docker'
  }
  async getInfoFromRuntime(): Promise<ContainerInfo> {
    return { status: 'running', port: this.port }
  }
}

interface Guest {
  http: Server
  streams: WebSocketServer
  port: number
}

/**
 * A guest on one port, as the agent container is: `/health` over HTTP and the
 * session stream over WebSocket. It acknowledges the stream, then sends
 * nothing. `answersPings: false` is a stalled stream as the host sees it (open,
 * and silent); `answersHealth: false` is a container that answers nothing.
 */
async function startGuest({ answersPings, answersHealth }: { answersPings: boolean; answersHealth: boolean }): Promise<Guest> {
  const http = createServer((request, response) => {
    if (!answersHealth) return request.socket.destroy()
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}')
  })
  const streams = new WebSocketServer({ server: http, autoPong: answersPings })
  streams.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', data: { message: 'Connected to session stream' } }))
  })
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  return { http, streams, port: (http.address() as AddressInfo).port }
}

async function subscribe(port: number): Promise<{ messages: StreamMessage[]; unsubscribe: () => void }> {
  const messages: StreamMessage[] = []
  const { ready, unsubscribe } = new Client(port).subscribeToStream('session-1', (message) => messages.push(message))
  await ready
  return { messages, unsubscribe }
}

// Pings, pongs and the health request cross real sockets, so only the ping interval is faked.
async function waitPast(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
    await vi.advanceTimersByTimeAsync(5_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const closes = (messages: StreamMessage[]) => messages.filter((m) => m.type === 'connection_closed')

describe('subscribeToStream watchdog', () => {
  let guest: Guest | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const client of guest?.streams.clients ?? []) client.terminate()
    guest?.http.closeAllConnections()
    await new Promise((resolve) => guest?.http.close(resolve) ?? resolve(undefined))
    guest = undefined
  })

  it('ends a stream that leaves pings unanswered while the container answers', async () => {
    guest = await startGuest({ answersPings: false, answersHealth: true })
    const { messages } = await subscribe(guest.port)

    await waitPast(45_000)
    expect(closes(messages)).toHaveLength(0)

    await waitPast(30_000)
    expect(closes(messages)).toHaveLength(1)
  })

  it('keeps a silent stream while the container answers nothing either', async () => {
    guest = await startGuest({ answersPings: false, answersHealth: false })
    const { messages, unsubscribe } = await subscribe(guest.port)

    await waitPast(180_000)

    expect(closes(messages)).toHaveLength(0)
    unsubscribe()
  })

  it('keeps a quiet stream whose guest answers pings', async () => {
    guest = await startGuest({ answersPings: true, answersHealth: true })
    const { messages, unsubscribe } = await subscribe(guest.port)

    await waitPast(180_000)

    expect(closes(messages)).toHaveLength(0)
    unsubscribe()
  })
})
