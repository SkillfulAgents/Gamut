/**
 * The official MCP client SDKs signing in with OAuth, exactly as an app built
 * on them does: an `OAuthClientProvider` (here in memory), the transport
 * discovering everything from the server's 401, registering (Dynamic Client
 * Registration, or a Client ID Metadata Document when the provider has one),
 * sending the person to the authorization URL with PKCE, and exchanging the
 * code the browser comes back with.
 *
 * v1 is `@modelcontextprotocol/sdk` (2025 era, what most clients run); v2 is
 * `@modelcontextprotocol/client`.
 */
import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2, UnauthorizedError as UnauthorizedErrorV2 } from '@modelcontextprotocol/client'
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError as UnauthorizedErrorV1 } from '@modelcontextprotocol/sdk/client/auth.js'

/** A loopback redirect nothing listens on: the browser's request to it is captured by the test. */
export const SDK_REDIRECT_URL = 'http://127.0.0.1:47123/callback'

/** Everything the SDK stores, in memory, inspectable. */
export class MemoryOAuthProvider {
  authorizationUrls: URL[] = []
  savedTokens: Array<Record<string, unknown>> = []
  private client: Record<string, unknown> | undefined
  private currentTokens: Record<string, unknown> | undefined
  private verifier = ''
  private discovery: unknown

  constructor(readonly name: string, readonly clientMetadataUrl?: string) {}

  get redirectUrl() {
    return SDK_REDIRECT_URL
  }

  get clientMetadata() {
    return {
      client_name: this.name,
      redirect_uris: [SDK_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  clientInformation() {
    return this.client as never
  }

  saveClientInformation(info: Record<string, unknown>) {
    this.client = info
  }

  tokens() {
    return this.currentTokens as never
  }

  saveTokens(tokens: Record<string, unknown>) {
    this.currentTokens = tokens
    this.savedTokens.push(tokens)
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrls.push(url)
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }

  codeVerifier() {
    return this.verifier
  }

  saveDiscoveryState(state: unknown) {
    this.discovery = state
  }

  discoveryState() {
    return this.discovery as never
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') this.currentTokens = undefined
    if (scope === 'all' || scope === 'client') this.client = undefined
    if (scope === 'all' || scope === 'verifier') this.verifier = ''
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined
  }

  /** The registered client id (DCR) or the document URL (CIMD). */
  get clientId(): string | undefined {
    return this.client?.client_id as string | undefined
  }

  get accessToken(): string | undefined {
    return this.currentTokens?.access_token as string | undefined
  }

  get refreshToken(): string | undefined {
    return this.currentTokens?.refresh_token as string | undefined
  }

  /** Replace the access token with one the server refuses, as an expired one is. */
  spoilAccessToken() {
    if (this.currentTokens) this.currentTokens = { ...this.currentTokens, access_token: 'expired-or-garbage' }
  }
}

export type SdkKind = 'v1' | 'v2'

export interface OAuthSession {
  kind: SdkKind
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  callTool(name: string, args?: Record<string, unknown>): Promise<{ content: Array<{ type: string; text?: string }>; structuredContent?: any; isError?: boolean }>
  close(): Promise<void>
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof UnauthorizedErrorV1 || error instanceof UnauthorizedErrorV2 || (error instanceof Error && /unauthorized/i.test(error.name + error.message))
}

async function open(kind: SdkKind, url: string, provider: MemoryOAuthProvider) {
  if (kind === 'v1') {
    const client = new ClientV1({ name: `gamut-e2e-oauth-${kind}`, version: '1.0.0' })
    const transport = new TransportV1(new URL(url), { authProvider: provider as never })
    return { client, transport, connect: () => client.connect(transport) }
  }
  const client = new ClientV2({ name: `gamut-e2e-oauth-${kind}`, version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } })
  const transport = new TransportV2(new URL(url), { authProvider: provider as never })
  return { client, transport, connect: () => client.connect(transport) }
}

function session(kind: SdkKind, client: ClientV1 | ClientV2): OAuthSession {
  return {
    kind,
    listTools: () => client.listTools() as never,
    callTool: (name, args = {}) => client.callTool({ name, arguments: args }) as never,
    close: () => client.close(),
  }
}

/**
 * Connect; when the server asks for sign-in, `authorize` is handed the URL the
 * SDK built and returns the callback the browser came back with. The SDK
 * exchanges its code and the connection is made again.
 */
export async function connectWithOAuth(
  kind: SdkKind,
  url: string,
  provider: MemoryOAuthProvider,
  authorize: (authorizationUrl: URL) => Promise<URL>,
): Promise<OAuthSession> {
  const first = await open(kind, url, provider)
  try {
    await first.connect()
    return session(kind, first.client)
  } catch (error) {
    if (!isUnauthorized(error)) throw error
  }
  const authorizationUrl = provider.authorizationUrls.at(-1)
  if (!authorizationUrl) throw new Error('the SDK refused the connection without asking for authorization')
  const callback = await authorize(authorizationUrl)
  const code = callback.searchParams.get('code')
  if (!code) throw new Error(`the browser came back without a code: ${callback.search}`)
  if (kind === 'v1') await (first.transport as TransportV1).finishAuth(code)
  else await (first.transport as TransportV2).finishAuth(callback.searchParams)
  const second = await open(kind, url, provider)
  await second.connect()
  return session(kind, second.client)
}

export { isUnauthorized }
