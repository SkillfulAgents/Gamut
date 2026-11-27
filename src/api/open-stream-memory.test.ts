import { afterEach, describe, expect, it } from 'vitest'
import { createServer, get } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

const FRAMES = 200_000
const MB = 1024 * 1024

// An event stream through the real Node adapter and a real socket, held open
// after its frames like a viewer's stream between events. @hono/node-server
// 2.1.5 to 2.1.7 chained one promise per chunk until the stream ended, so a
// host kept memory for every frame it had sent on every stream still open.
describe('an open event stream over the Node HTTP adapter', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (!server) return
    server.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))
    server = undefined
  })

  it('keeps no memory for the frames it has sent', async () => {
    setFlagsFromString('--expose-gc')
    const gc = runInNewContext('gc') as () => void
    const heapUsedMb = () => {
      gc()
      return process.memoryUsage().heapUsed / MB
    }

    let allFramesSent!: () => void
    const sent = new Promise<void>((resolve) => { allFramesSent = resolve })
    const app = new Hono()
    app.get('/stream', (c) => streamSSE(c, async (stream) => {
      for (let frame = 0; frame < FRAMES; frame++) {
        await stream.writeSSE({ data: '{"type":"ping"}', event: 'message' })
        // A few frames per turn of the event loop, so the socket never falls
        // behind: the adapter starts a new chain each time it waits for one.
        if (frame % 10 === 9) await new Promise((resolve) => setImmediate(resolve))
      }
      allFramesSent()
      await new Promise<void>((resolve) => stream.onAbort(resolve))
    }))
    server = createServer(getRequestListener(app.fetch))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo

    const before = heapUsedMb()
    const request = get({ host: '127.0.0.1', port, path: '/stream' }, (response) => response.resume())
    request.on('error', () => {})
    await sent
    const whileOpen = heapUsedMb()
    request.destroy()

    expect(whileOpen - before).toBeLessThan(5)
  }, 30_000)
})
