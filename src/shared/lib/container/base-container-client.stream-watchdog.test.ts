import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// A guest that acknowledges the stream, then goes quiet. With autoPong off it
// is what a stalled port proxy looks like from the host: open, and silent.
async function startGuest(autoPong: boolean): Promise<{ server: WebSocketServer; port: number }> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong })
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'status', data: { message: 'Connected to session stream' } }))
  })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return { server, port: (server.address() as AddressInfo).port }
}

async function subscribe(port: number): Promise<{ messages: StreamMessage[]; unsubscribe: () => void }> {
  const messages: StreamMessage[] = []
  const { ready, unsubscribe } = new Client(port).subscribeToStream('session-1', (message) => messages.push(message))
  await ready
  return { messages, unsubscribe }
}

// Pings and pongs cross a real socket, so only the interval clock is faked.
async function waitPast(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
    await vi.advanceTimersByTimeAsync(5_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('subscribeToStream watchdog', () => {
  let server: WebSocketServer | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const client of server?.clients ?? []) client.terminate()
    await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined))
    server = undefined
  })

  it('ends a stream that stops answering pings and reports connection_closed', async () => {
    const guest = await startGuest(false)
    server = guest.server
    const { messages } = await subscribe(guest.port)

    await waitPast(60_000)

    expect(messages.filter((m) => m.type === 'connection_closed')).toHaveLength(1)
  })

  it('keeps a quiet stream whose guest answers pings', async () => {
    const guest = await startGuest(true)
    server = guest.server
    const { messages, unsubscribe } = await subscribe(guest.port)

    await waitPast(120_000)

    expect(messages.some((m) => m.type === 'connection_closed')).toBe(false)
    unsubscribe()
  })
})
