/**
 * Drives the MCP OAuth flow against the app in a vitest process, with no
 * browser: sign a person up, register a client (DCR), authorize with PKCE,
 * approve consent the way the consent page does, exchange the code. Each step
 * returns the raw response too, so a test can stop at any step and look.
 */
import { createHash, randomBytes } from 'node:crypto'

export type AppFetch = (path: string, init?: RequestInit) => Promise<Response>

export const TEST_REDIRECT_URI = 'http://127.0.0.1:47999/callback'

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function cookiesOf(response: Response): string {
  return response.headers.getSetCookie()
    .filter((value) => !/max-age=0(?:;|$)/i.test(value))
    .map((value) => value.split(';')[0])
    .join('; ')
}

export interface FlowOptions {
  base: string
  fetch: AppFetch
}

export async function signUp(options: FlowOptions, email: string, password = 'OauthFlowPassword123!'): Promise<{ cookie: string; userId: string }> {
  const response = await options.fetch('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { origin: options.base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: email.split('@')[0] }),
  })
  if (response.status !== 200) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`)
  const body = await response.json() as { user: { id: string } }
  return { cookie: cookiesOf(response), userId: body.user.id }
}

export async function signIn(options: FlowOptions, email: string, password = 'OauthFlowPassword123!'): Promise<string> {
  const response = await options.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { origin: options.base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`)
  return cookiesOf(response)
}

export async function registerClient(options: FlowOptions, body: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Response> {
  const payload = JSON.stringify({
    client_name: 'Flow Test Client',
    redirect_uris: [TEST_REDIRECT_URI],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...body,
  })
  return options.fetch('/api/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)), ...headers },
    body: payload,
  })
}

export async function registeredClientId(options: FlowOptions, body: Record<string, unknown> = {}): Promise<string> {
  const response = await registerClient(options, body)
  if (response.status !== 200 && response.status !== 201) throw new Error(`register failed: ${response.status} ${await response.text()}`)
  return (await response.json() as { client_id: string }).client_id
}

export interface AuthorizeParams {
  clientId: string
  redirectUri?: string
  scope?: string
  challenge?: string | null
  method?: string | null
  resource?: string | null
  state?: string
  extra?: Record<string, string>
}

export function authorizeQuery(options: FlowOptions, params: AuthorizeParams): URLSearchParams {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri ?? TEST_REDIRECT_URI,
    scope: params.scope ?? 'gamut:read gamut:run',
    state: params.state ?? 'state-123',
  })
  if (params.challenge !== null) query.set('code_challenge', params.challenge ?? pkcePair().challenge)
  if (params.method !== null) query.set('code_challenge_method', params.method ?? 'S256')
  if (params.resource !== null) query.set('resource', params.resource ?? `${options.base}/mcp`)
  for (const [key, value] of Object.entries(params.extra ?? {})) query.set(key, value)
  return query
}

/** GET /oauth2/authorize as a browser would (no JSON accept), returning the redirect. */
export async function authorize(options: FlowOptions, cookie: string | null, params: AuthorizeParams): Promise<Response> {
  return options.fetch(`/api/auth/oauth2/authorize?${authorizeQuery(options, params)}`, {
    headers: { ...(cookie ? { cookie } : {}), accept: 'text/html' },
    redirect: 'manual',
  })
}

/** The consent page's answer: POST /oauth2/consent with the signed query it was opened with. */
export async function consent(options: FlowOptions, cookie: string, consentUrl: string, accept: boolean, scope?: string): Promise<Response> {
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- a test URL
  const oauthQuery = new URL(consentUrl, options.base).search.slice(1)
  return options.fetch('/api/auth/oauth2/consent', {
    method: 'POST',
    headers: { cookie, origin: options.base, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ accept, oauth_query: oauthQuery, ...(scope ? { scope } : {}) }),
  })
}

export async function tokenRequest(options: FlowOptions, form: Record<string, string>): Promise<Response> {
  return options.fetch('/api/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  })
}

export interface IssuedTokens {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
  scope: string
}

/** The whole flow for a signed-in person: authorize, consent, code, tokens. */
export async function connectClient(options: FlowOptions, cookie: string, clientId: string, scope = 'gamut:read gamut:run'): Promise<IssuedTokens & { code: string; verifier: string }> {
  const { verifier, challenge } = pkcePair()
  const redirect = await authorize(options, cookie, { clientId, scope, challenge })
  const location = redirect.headers.get('location')
  if (!location) throw new Error(`authorize did not redirect: ${redirect.status} ${await redirect.text()}`)
  let codeUrl = location
  if (location.includes('/oauth/consent')) {
    const answered = await consent(options, cookie, location, true)
    if (answered.status !== 200) throw new Error(`consent failed: ${answered.status} ${await answered.text()}`)
    codeUrl = (await answered.json() as { url: string }).url
  }
  const code = URL.parse(codeUrl)?.searchParams.get('code')
  if (!code) throw new Error(`no code in ${codeUrl}`)
  const tokens = await tokenRequest(options, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: TEST_REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
    resource: `${options.base}/mcp`,
  })
  if (tokens.status !== 200) throw new Error(`token failed: ${tokens.status} ${await tokens.text()}`)
  return { ...(await tokens.json() as IssuedTokens), code, verifier }
}
