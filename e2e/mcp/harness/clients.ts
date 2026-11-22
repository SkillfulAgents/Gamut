/**
 * Official MCP clients connected to the server under test: the v2 SDK
 * (`@modelcontextprotocol/client`, either era) and the v1 SDK
 * (`@modelcontextprotocol/sdk`, what most clients in the field run, 2025 era).
 * Each sends the installation token the way a configured client does: an
 * `Authorization` header on every request.
 */
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export const MODERN_REVISION = '2026-07-28'

/** What a test needs of a connected client, whichever SDK it is. */
export interface ConnectedClient {
  label: string
  listTools(): Promise<{ tools: Array<{ name: string; title?: string; description?: string; annotations?: Record<string, unknown>; outputSchema?: unknown; inputSchema?: unknown }> }>
  callTool(name: string, args?: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }>; structuredContent?: any; isError?: boolean }>
  instructions(): string | undefined
  serverName(): string | undefined
  close(): Promise<void>
}

function authHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` }
}

/**
 * The v2 client. `legacy` runs the 2025 `initialize` handshake; `modern`
 * pins 2026-07-28 (a `server/discover` probe, the version on every request);
 * `auto` probes and takes what the server offers.
 */
export async function connectV2(url: string, token: string | null, era: 'legacy' | 'modern' | 'auto'): Promise<ConnectedClient> {
  const mode = era === 'modern' ? { pin: MODERN_REVISION } : era
  const client = new ClientV2({ name: `gamut-e2e-v2-${era}`, version: '1.0.0' }, { versionNegotiation: { mode } })
  const transport = new TransportV2(new URL(url), { requestInit: { headers: authHeaders(token) } })
  await client.connect(transport)
  return {
    label: `v2 SDK (${era})`,
    listTools: () => client.listTools() as never,
    callTool: (name, args = {}) => client.callTool({ name, arguments: args }) as never,
    instructions: () => client.getInstructions(),
    serverName: () => client.getServerVersion()?.name,
    close: () => client.close(),
  }
}

/** The v1 client: the 2025 handshake over streamable HTTP. */
export async function connectV1(url: string, token: string | null): Promise<ConnectedClient> {
  const client = new ClientV1({ name: 'gamut-e2e-v1', version: '1.0.0' })
  const transport = new TransportV1(new URL(url), { requestInit: { headers: authHeaders(token) } })
  await client.connect(transport)
  return {
    label: 'v1 SDK',
    listTools: () => client.listTools() as never,
    callTool: (name, args = {}) => client.callTool({ name, arguments: args }) as never,
    instructions: () => client.getInstructions(),
    serverName: () => client.getServerVersion()?.name,
    close: () => client.close(),
  }
}

/** Every client the suites run against: both SDK generations, both eras. */
export const CLIENT_KINDS = ['v1', 'v2-legacy', 'v2-modern', 'v2-auto'] as const
export type ClientKind = (typeof CLIENT_KINDS)[number]

export function connect(kind: ClientKind, url: string, token: string | null): Promise<ConnectedClient> {
  switch (kind) {
    case 'v1': return connectV1(url, token)
    case 'v2-legacy': return connectV2(url, token, 'legacy')
    case 'v2-modern': return connectV2(url, token, 'modern')
    case 'v2-auto': return connectV2(url, token, 'auto')
  }
}

/** The tool result's JSON, checked against its text: the two must say the same. */
export function resultJson(result: Awaited<ReturnType<ConnectedClient['callTool']>>): any {
  if (result.isError) throw new Error(`Tool error: ${result.content.map((block) => block.text).join('\n')}`)
  const text = result.content.find((block) => block.type === 'text')?.text
  if (!text) throw new Error('Tool result has no text block')
  const parsed = JSON.parse(text)
  if (JSON.stringify(parsed) !== JSON.stringify(result.structuredContent)) {
    throw new Error('Tool result text and structuredContent differ')
  }
  return parsed
}
