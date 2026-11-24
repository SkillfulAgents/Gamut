/**
 * A local HTTP proxy that adds headers to every request and streams the
 * answer back unchanged (SSE included). For tools that cannot send a header of
 * their own (the MCP conformance suite has no auth option): they reach the
 * real endpoint through the real token check.
 */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface HeaderProxy {
  /** The proxy's origin; append the target's path. */
  origin: string
  /** Requests seen, for assertions: the HTTP method and path, the answer's status, and the MCP routing headers. */
  seen: Array<{ method: string; path: string; status: number; mcpMethod: string | null; protocolVersion: string | null }>
  close(): Promise<void>
}

export async function startHeaderProxy(target: string, headers: Record<string, string>): Promise<HeaderProxy> {
  const targetUrl = new URL(target)
  const seen: HeaderProxy['seen'] = []
  const server = http.createServer((incoming, outgoing) => {
    const forwardHeaders = { ...incoming.headers, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) }
    delete forwardHeaders.host
    const upstream = http.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: incoming.method,
      path: incoming.url,
      headers: { ...forwardHeaders, host: targetUrl.host },
    }, (answer) => {
      seen.push({
        method: incoming.method ?? 'GET',
        path: incoming.url ?? '/',
        status: answer.statusCode ?? 0,
        mcpMethod: (incoming.headers['mcp-method'] as string | undefined) ?? null,
        protocolVersion: (incoming.headers['mcp-protocol-version'] as string | undefined) ?? null,
      })
      outgoing.writeHead(answer.statusCode ?? 502, answer.headers)
      answer.pipe(outgoing)
    })
    upstream.on('error', (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'Content-Type': 'text/plain' })
      outgoing.end(`proxy error: ${error.message}`)
    })
    incoming.pipe(upstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
