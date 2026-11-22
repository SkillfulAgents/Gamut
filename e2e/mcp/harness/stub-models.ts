/**
 * Stand-ins for the model APIs real agent CLIs call, so Claude Code and Codex
 * can start a turn, list their MCP tools and finish, with no account and no
 * model call. Each answers every turn with one short text reply and records
 * the request bodies, which carry the tools the CLI offers its model.
 *
 * - Anthropic Messages (`POST /v1/messages`, streaming or not), for Claude Code
 *   with ANTHROPIC_BASE_URL pointed here.
 * - OpenAI Responses (`POST /v1/responses`, streaming), for Codex with a custom
 *   model provider whose base_url is `<origin>/v1`.
 */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StubModel {
  origin: string
  /** Every request seen: method, path and parsed JSON body (null when none). */
  requests: Array<{ method: string; path: string; body: any }>
  close(): Promise<void>
}

export const STUB_REPLY = 'Stub model reply: done.'

function sse(res: http.ServerResponse, events: Array<{ event: string; data: unknown }>) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  for (const { event, data } of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  res.end()
}

function anthropic(body: any, res: http.ServerResponse) {
  const id = `msg_stub_${Date.now()}`
  const model = body?.model ?? 'claude-stub'
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  if (!body?.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: STUB_REPLY }], stop_reason: 'end_turn', stop_sequence: null, usage }))
    return
  }
  sse(res, [
    { event: 'message_start', data: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: STUB_REPLY } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ])
}

function openaiResponses(body: any, res: http.ServerResponse) {
  const id = `resp_stub_${Date.now()}`
  const itemId = `msg_stub_${Date.now()}`
  const model = body?.model ?? 'gpt-stub'
  const message = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: STUB_REPLY, annotations: [] }] }
  const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 }
  const base = { id, object: 'response', created_at: Math.floor(Date.now() / 1000), model }
  sse(res, [
    { event: 'response.created', data: { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: STUB_REPLY } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: 0, item: message } },
    { event: 'response.completed', data: { type: 'response.completed', response: { ...base, status: 'completed', output: [message], usage } } },
  ])
}

export async function startStubModel(): Promise<StubModel> {
  const requests: StubModel['requests'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = null
      try { body = raw ? JSON.parse(raw) : null } catch { body = raw }
      const path = (req.url ?? '/').split('?')[0]
      requests.push({ method: req.method ?? 'GET', path, body })
      if (req.method === 'POST' && path === '/v1/messages') return anthropic(body, res)
      if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ input_tokens: 10 }))
      }
      if (req.method === 'POST' && path === '/v1/responses') return openaiResponses(body, res)
      if (req.method === 'GET' && path === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'not_found', message: `stub model: no ${req.method} ${path}` } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}
