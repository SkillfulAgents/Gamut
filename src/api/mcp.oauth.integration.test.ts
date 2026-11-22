/**
 * `/mcp` in an auth-mode deployment, as the real app mounts it
 * (src/api/index.ts): the deployment as its own OAuth authorization server
 * (Better Auth's jwt + @better-auth/mcp + @better-auth/cimd) and `/mcp` as the
 * resource server. Real HTTP handling, real Better Auth, real database (SQLite
 * and libsql); no browser, so the consent page's one call is made directly.
 *
 * Covers the discovery documents, the 401/403 challenges, every way a token
 * is refused (audience, issuer, expiry, signature, `alg`, sessions, the
 * installation token, inactive or removed accounts, revocation), the
 * authorization server's checks (PKCE, redirect URI, resource, code replay,
 * refresh rotation and reuse), consent, open registration limits, CIMD
 * fetch refusals, and the settings routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { SignJWT, base64url, decodeJwt, decodeProtectedHeader } from 'jose'
import { createTestDatabase, type TestDatabase } from '@shared/lib/db/testing/create-test-database'
import { backgroundSettled } from '@shared/lib/background'
import { auditLog, oauthConsent, oauthRefreshToken, user } from '@shared/lib/db/schema'

const BASE = 'http://localhost:47891'
const RESOURCE = `${BASE}/mcp`
vi.hoisted(() => {
  process.env.AUTH_MODE = 'true'
  process.env.TRUSTED_ORIGINS = 'http://localhost:47891'
  process.env.BETTER_AUTH_SECRET = 'mcp-oauth-test-secret-0123456789abcdef0123456789abcdef'
  process.env.AUTH_PROVIDERS_JSON = '[]'
})

let handle: TestDatabase
vi.mock('@shared/lib/db', () => ({ get db() { return handle.db } }))

import app from './index'
import { setMcpServerEnabled } from '@shared/lib/mcp-server/mcp-server-settings'
import { mutateSettings } from '@shared/lib/config/settings'
import { getAuth, resetAuth } from '@shared/lib/auth'
import { getOrCreateMcpInstallationToken } from '@shared/lib/mcp-server/installation-token'
import { DCR_LIMITS } from '@shared/lib/mcp-server/oauth/oauth-config'
import { deleteUnusedClientRegistrations, STALE_REGISTRATION_MS } from '@shared/lib/mcp-server/oauth/client-cleanup'
import { oauthClient } from '@shared/lib/db/schema'
import * as flow from '@shared/lib/mcp-server/oauth/testing/oauth-flow'

const options: flow.FlowOptions = { base: BASE, fetch: async (path, init) => app.request(`${BASE}${path}`, init) }

let seq = 0
const email = (name: string) => `${name}-${++seq}@example.com`

beforeAll(async () => {
  handle = await createTestDatabase()
  resetAuth()
  // Every test signs people up.
  await mutateSettings((draft) => { draft.auth = { ...draft.auth, signupMode: 'open', requireAdminApproval: false } })
})

beforeEach(async () => {
  await setMcpServerEnabled(true)
})

afterAll(async () => {
  await backgroundSettled()
  await handle.close()
  resetAuth()
})

const MODERN_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }

function mcpPost(body: unknown, token: string | null, extra: Record<string, string> = {}): Promise<Response> {
  return options.fetch('/mcp', {
    method: 'POST',
    headers: { ...MODERN_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  })
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'self-reported', version: '1' } } }
const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
const callTool = (name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } })

/** The JSON-RPC result of an SSE or JSON answer. */
async function rpcResult(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const data = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}'
  return JSON.parse(data) as Record<string, unknown>
}

/** A signed-in person with a connected client and fresh tokens. */
async function connected(scope = 'gamut:read gamut:run', who = email('member')) {
  const person = await flow.signUp(options, who)
  const clientId = await flow.registeredClientId(options)
  const tokens = await flow.connectClient(options, person.cookie, clientId, scope)
  return { ...person, clientId, tokens, email: who }
}

/** A JWT signed with this deployment's own key: what a forger with no key cannot make. */
async function signWithServerKey(payload: Record<string, unknown>): Promise<string> {
  const auth = await getAuth()
  const { token } = await (auth.api as unknown as { signJWT: (input: { body: { payload: Record<string, unknown> } }) => Promise<{ token: string }> })
    .signJWT({ body: { payload } })
  return token
}

function wwwAuthenticate(response: Response): string {
  return response.headers.get('www-authenticate') ?? ''
}

describe('discovery documents', () => {
  it('serves RFC 9728 metadata whose resource is exactly the /mcp URL, at both paths', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await options.fetch(path)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [BASE],
        scopes_supported: ['gamut:read', 'gamut:run'],
        bearer_methods_supported: ['header'],
        resource_name: 'Gamut',
        resource_documentation: `${BASE}/settings/mcp-server`,
      })
    }
  })

  it('serves RFC 8414 metadata for the deployment as issuer', async () => {
    const response = await options.fetch('/.well-known/oauth-authorization-server')
    expect(response.status).toBe(200)
    const metadata = await response.json() as Record<string, unknown>
    expect(metadata).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/api/auth/oauth2/authorize`,
      token_endpoint: `${BASE}/api/auth/oauth2/token`,
      registration_endpoint: `${BASE}/api/auth/oauth2/register`,
      revocation_endpoint: `${BASE}/api/auth/oauth2/revoke`,
      jwks_uri: `${BASE}/api/auth/jwks`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      authorization_response_iss_parameter_supported: true,
    })
    expect(metadata.scopes_supported).toEqual(expect.arrayContaining(['gamut:read', 'gamut:run']))
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none')
  })

  it('answers the OpenID configuration with a JSON 404 (not an OpenID provider)', async () => {
    const response = await options.fetch('/.well-known/openid-configuration')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  it('serves nothing while the admin switch is off, and /mcp is a 404', async () => {
    await setMcpServerEnabled(false)
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      expect((await options.fetch(path)).status).toBe(404)
    }
    const response = await mcpPost(toolsList, null)
    expect(response.status).toBe(404)
    expect(response.headers.get('www-authenticate')).toBeNull()
  })
})

describe('the 401 challenge', () => {
  it('points an unauthenticated request at the resource metadata, with the scopes', async () => {
    const response = await mcpPost(toolsList, null)
    expect(response.status).toBe(401)
    expect(wwwAuthenticate(response)).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="gamut:read gamut:run"`)
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate')
  })

  it('adds invalid_token when a token was sent', async () => {
    const response = await mcpPost(toolsList, 'not-a-token')
    expect(response.status).toBe(401)
    expect(wwwAuthenticate(response)).toMatch(/^Bearer error="invalid_token", error_description="[^"]+", resource_metadata="http:\/\/localhost:47891\/\.well-known\/oauth-protected-resource\/mcp", scope="gamut:read gamut:run"$/)
  })
})

describe('a connected client', () => {
  it('lists the tools, calls a read tool, and is named in the audit row by its registered name', async () => {
    const { tokens } = await connected()
    const header = decodeProtectedHeader(tokens.access_token)
    const claims = decodeJwt(tokens.access_token)
    expect(header).toMatchObject({ alg: 'EdDSA', typ: 'at+jwt' })
    expect(claims.aud).toBe(RESOURCE)
    expect(claims.iss).toBe(BASE)
    expect(Number(claims.exp) - Number(claims.iat)).toBe(15 * 60)
    expect(tokens.expires_in).toBe(900)
    expect(tokens.refresh_token).toMatch(/^gamut_rt_/)

    expect((await mcpPost(initialize, tokens.access_token)).status).toBe(200)
    const listed = await rpcResult(await mcpPost(toolsList, tokens.access_token))
    const names = ((listed.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['get_guide', 'list_agents', 'invoke_agent']))

    const called = await rpcResult(await mcpPost(callTool('get_guide'), tokens.access_token))
    expect((called.result as { isError?: boolean }).isError).toBeFalsy()
    await backgroundSettled()
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.object, 'mcp_tool')).all()
    const row = rows.at(-1)
    expect(JSON.parse(row?.details ?? '{}')).toMatchObject({ tool: 'get_guide', client: 'Flow Test Client', credential: 'oauth' })
  })
})

describe('tokens /mcp refuses', () => {
  it('a token for another audience, another issuer, an expired one, or one without a client', async () => {
    const { userId, tokens } = await connected()
    const claims = decodeJwt(tokens.access_token)
    const now = Math.floor(Date.now() / 1000)
    const base = { sub: userId, azp: claims.azp, client_id: claims.azp, scope: 'gamut:read gamut:run', iss: BASE, aud: RESOURCE, iat: now, exp: now + 600 }
    const forged = [
      { ...base, aud: BASE },
      { ...base, aud: `${RESOURCE}/other` },
      { ...base, aud: [RESOURCE, 'https://evil.example/mcp'] },
      { ...base, iss: 'https://evil.example' },
      { ...base, iat: now - 3600, exp: now - 60 },
      { ...base, azp: undefined },
      { ...base, scope: undefined },
    ]
    // The sanity case: the same payload with nothing wrong is accepted.
    expect((await mcpPost(initialize, await signWithServerKey(base))).status).toBe(200)
    for (const payload of forged) {
      const response = await mcpPost(initialize, await signWithServerKey(payload))
      expect(response.status, JSON.stringify(payload)).toBe(401)
      expect(wwwAuthenticate(response)).toContain('error="invalid_token"')
    }
  })

  it('a bad signature, alg none, and HS256 keyed with the public key', async () => {
    const { tokens } = await connected()
    const [headerPart, payloadPart, signature] = tokens.access_token.split('.')
    const flipped = `${headerPart}.${payloadPart}.${signature.slice(0, -4)}${signature.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`
    const unsigned = `${base64url.encode(JSON.stringify({ alg: 'none', typ: 'at+jwt' }))}.${payloadPart}.`
    const jwks = await (await getAuth()).api.getJwks() as { keys: Array<{ x: string; kid: string }> }
    const hmac = await new SignJWT(decodeJwt(tokens.access_token))
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: jwks.keys[0].kid })
      .sign(new TextEncoder().encode(jwks.keys[0].x))
    for (const token of [flipped, unsigned, hmac]) {
      expect((await mcpPost(initialize, token)).status).toBe(401)
    }
  })

  it('a session token, as a bearer or as the cookie', async () => {
    const { cookie } = await connected()
    const sessionToken = decodeURIComponent(cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('better-auth.session_token='))!.split('=')[1]).split('.')[0]
    expect((await mcpPost(initialize, sessionToken)).status).toBe(401)
    expect((await mcpPost(initialize, null, { cookie })).status).toBe(401)
  })

  it('the installation token', async () => {
    expect((await mcpPost(initialize, await getOrCreateMcpInstallationToken())).status).toBe(401)
  })

  it('the token of an invited, a banned and a removed person', async () => {
    for (const change of ['invited', 'banned', 'removed'] as const) {
      const { userId, tokens } = await connected()
      expect((await mcpPost(initialize, tokens.access_token)).status).toBe(200)
      if (change === 'invited') await handle.db.update(user).set({ status: 'invited' }).where(eq(user.id, userId)).run()
      if (change === 'banned') await handle.db.update(user).set({ banned: true }).where(eq(user.id, userId)).run()
      if (change === 'removed') await handle.db.delete(user).where(eq(user.id, userId)).run()
      const response = await mcpPost(initialize, tokens.access_token)
      expect(response.status, change).toBe(401)
    }
  })

  it('stops a revoked client at once, and its refresh token with it', async () => {
    const { cookie, clientId, tokens } = await connected()
    expect((await mcpPost(initialize, tokens.access_token)).status).toBe(200)
    const revoked = await options.fetch('/api/mcp-server/oauth/clients/revoke', {
      method: 'POST',
      headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId }),
    })
    expect(revoked.status).toBe(200)
    const refused = await mcpPost(initialize, tokens.access_token)
    expect(refused.status).toBe(401)
    expect(wwwAuthenticate(refused)).toContain('disconnected')
    const refresh = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE })
    expect(refresh.status).toBe(400)
    expect(await refresh.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('a token issued before the person reconnected the client', async () => {
    const { cookie, clientId, tokens } = await connected()
    await options.fetch('/api/mcp-server/oauth/clients/revoke', {
      method: 'POST', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ clientId }),
    })
    // Reconnect in a later second: the new consent postdates the old token.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const fresh = await flow.connectClient(options, cookie, clientId)
    expect((await mcpPost(initialize, fresh.access_token)).status).toBe(200)
    expect((await mcpPost(initialize, tokens.access_token)).status).toBe(401)
  })
})

describe('MCP tokens on /api', () => {
  it('are not sessions: Authenticated() routes and get-session refuse them', async () => {
    const { tokens } = await connected()
    expect((await options.fetch('/api/mcp-server', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401)
    expect((await options.fetch('/api/agents', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401)
    const session = await options.fetch('/api/auth/get-session', { headers: { authorization: `Bearer ${tokens.access_token}` } })
    expect(await session.json()).toBeNull()
    // Nor is the refresh token.
    expect((await options.fetch('/api/mcp-server', { headers: { authorization: `Bearer ${tokens.refresh_token}` } })).status).toBe(401)
  })

  it('cannot be minted from a session: the jwt plugin\'s /token is off', async () => {
    const { cookie } = await connected()
    expect((await options.fetch('/api/auth/token', { headers: { cookie } })).status).toBe(404)
  })
})

describe('scopes', () => {
  it('a read-only token reads, and a run tool gets 403 insufficient_scope naming what it needs', async () => {
    const { tokens } = await connected('gamut:read')
    expect(tokens.scope.split(' ')).toEqual(expect.arrayContaining(['gamut:read']))
    expect(tokens.scope).not.toContain('gamut:run')
    const read = await rpcResult(await mcpPost(callTool('get_guide'), tokens.access_token))
    expect((read.result as { isError?: boolean }).isError).toBeFalsy()
    const run = await mcpPost(callTool('invoke_agent', { agent: 'x', prompt: 'hi' }), tokens.access_token)
    expect(run.status).toBe(403)
    expect(wwwAuthenticate(run)).toBe(`Bearer error="insufficient_scope", scope="gamut:read gamut:run", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", error_description="This tool needs the gamut:run permission, which this connection was not given."`)
  })

  it('the person can narrow the scopes at consent', async () => {
    const person = await flow.signUp(options, email('narrow'))
    const clientId = await flow.registeredClientId(options)
    const { verifier, challenge } = flow.pkcePair()
    const location = (await flow.authorize(options, person.cookie, { clientId, challenge })).headers.get('location')!
    const answered = await flow.consent(options, person.cookie, location, true, 'gamut:read offline_access')
    const code = new URL((await answered.json() as { url: string }).url).searchParams.get('code')!
    const tokens = await (await flow.tokenRequest(options, { grant_type: 'authorization_code', code, redirect_uri: flow.TEST_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: RESOURCE })).json() as flow.IssuedTokens
    expect(decodeJwt(tokens.access_token).scope).toBe('gamut:read offline_access')
    expect((await mcpPost(callTool('invoke_agent', { agent: 'x', prompt: 'hi' }), tokens.access_token)).status).toBe(403)
  })
})

describe('the authorization server', () => {
  it('sends a signed-out person to the consent page, which signs them in first', async () => {
    const clientId = await flow.registeredClientId(options)
    const response = await flow.authorize(options, null, { clientId })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toMatch(/^\/oauth\/consent\?.*client_id=.*&sig=/)
  })

  it('requires PKCE S256 and the matching verifier', async () => {
    const person = await flow.signUp(options, email('pkce'))
    const clientId = await flow.registeredClientId(options)
    for (const params of [{ challenge: null, method: null }, { method: 'plain' }, { challenge: 'abc', method: null }]) {
      const response = await flow.authorize(options, person.cookie, { clientId, ...params })
      const location = response.headers.get('location') ?? ''
      expect(location, JSON.stringify(params)).toMatch(/^http:\/\/127\.0\.0\.1:47999\/callback\?error=invalid_request/)
    }
    const tokens = await flow.connectClient(options, person.cookie, clientId).catch((error: Error) => error)
    expect(tokens).not.toBeInstanceOf(Error)
    // A wrong verifier for a fresh code.
    const { challenge } = flow.pkcePair()
    const location = (await flow.authorize(options, person.cookie, { clientId, challenge })).headers.get('location')!
    const code = new URL(location.startsWith('http') ? location : (await (await flow.consent(options, person.cookie, location, true)).json() as { url: string }).url).searchParams.get('code')!
    const wrong = await flow.tokenRequest(options, { grant_type: 'authorization_code', code, redirect_uri: flow.TEST_REDIRECT_URI, client_id: clientId, code_verifier: flow.pkcePair().verifier, resource: RESOURCE })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('refuses a redirect URI that was not registered, and accepts a loopback one on another port', async () => {
    const person = await flow.signUp(options, email('redirect'))
    const clientId = await flow.registeredClientId(options)
    for (const redirectUri of ['http://127.0.0.1:47999/other', 'https://evil.example/callback', 'http://127.0.0.1.evil.example:47999/callback']) {
      const response = await flow.authorize(options, person.cookie, { clientId, redirectUri })
      const location = response.headers.get('location') ?? ''
      expect(location.startsWith(redirectUri), redirectUri).toBe(false)
      expect(location).not.toContain('code=')
    }
    const otherPort = await flow.authorize(options, person.cookie, { clientId, redirectUri: 'http://127.0.0.1:51234/callback' })
    expect(otherPort.headers.get('location')).toMatch(/^\/oauth\/consent\?/)
  })

  it('refuses a resource other than /mcp, at authorize and at the token endpoint', async () => {
    const person = await flow.signUp(options, email('resource'))
    const clientId = await flow.registeredClientId(options)
    const response = await flow.authorize(options, person.cookie, { clientId, resource: 'https://evil.example/mcp' })
    expect(response.headers.get('location')).toMatch(/error=invalid_target/)
    const { verifier, challenge } = flow.pkcePair()
    const location = (await flow.authorize(options, person.cookie, { clientId, challenge })).headers.get('location')!
    const code = new URL((await (await flow.consent(options, person.cookie, location, true)).json() as { url: string }).url).searchParams.get('code')!
    const tokens = await flow.tokenRequest(options, { grant_type: 'authorization_code', code, redirect_uri: flow.TEST_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: 'https://evil.example/mcp' })
    expect(tokens.status).toBe(400)
    expect((await tokens.json() as { error: string }).error).toMatch(/invalid_target|invalid_grant/)
  })

  it('binds a token to /mcp when the client names no resource', async () => {
    const person = await flow.signUp(options, email('noresource'))
    const clientId = await flow.registeredClientId(options)
    const { verifier, challenge } = flow.pkcePair()
    const location = (await flow.authorize(options, person.cookie, { clientId, challenge, resource: null })).headers.get('location')!
    const code = new URL((await (await flow.consent(options, person.cookie, location, true)).json() as { url: string }).url).searchParams.get('code')!
    const tokens = await (await flow.tokenRequest(options, { grant_type: 'authorization_code', code, redirect_uri: flow.TEST_REDIRECT_URI, client_id: clientId, code_verifier: verifier })).json() as flow.IssuedTokens
    expect(decodeJwt(tokens.access_token).aud).toBe(RESOURCE)
  })

  it('refuses a code used twice', async () => {
    const person = await flow.signUp(options, email('replay'))
    const clientId = await flow.registeredClientId(options)
    const first = await flow.connectClient(options, person.cookie, clientId)
    const again = await flow.tokenRequest(options, { grant_type: 'authorization_code', code: first.code, redirect_uri: flow.TEST_REDIRECT_URI, client_id: clientId, code_verifier: first.verifier, resource: RESOURCE })
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ error: 'invalid_grant' })
  })

  it('rotates refresh tokens, and a reused one past the overlap revokes the family with invalid_grant', async () => {
    const { clientId, tokens } = await connected()
    const refreshed = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE })
    expect(refreshed.status).toBe(200)
    const next = await refreshed.json() as flow.IssuedTokens
    expect(next.refresh_token).toBeTruthy()
    expect(next.refresh_token).not.toBe(tokens.refresh_token)
    expect((await mcpPost(initialize, next.access_token)).status).toBe(200)

    // A retry inside the overlap gets the same answer, not a new family.
    const retried = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE })
    expect(retried.status).toBe(200)
    expect((await retried.json() as flow.IssuedTokens).refresh_token).toBe(next.refresh_token)

    // Past it, the old token is replay: refused, and the newer one dies with it.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 })
    try {
      const replayed = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE })
      expect(replayed.status).toBe(400)
      expect(await replayed.json()).toMatchObject({ error: 'invalid_grant' })
      const family = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: next.refresh_token!, client_id: clientId, resource: RESOURCE })
      expect(family.status).toBe(400)
      expect(await family.json()).toMatchObject({ error: 'invalid_grant' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers invalid_grant for a refresh token it never issued', async () => {
    const clientId = await flow.registeredClientId(options)
    for (const refreshToken of ['gamut_rt_neverIssuedNeverIssuedNeverIss', 'not-even-ours']) {
      const response = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
      expect(response.status, refreshToken).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_grant' })
    }
  })

  it('sends access_denied to the client when the person declines', async () => {
    const person = await flow.signUp(options, email('deny'))
    const clientId = await flow.registeredClientId(options)
    const location = (await flow.authorize(options, person.cookie, { clientId, state: 'deny-state' })).headers.get('location')!
    const answered = await flow.consent(options, person.cookie, location, false)
    const url = new URL((await answered.json() as { url: string }).url)
    expect(url.origin + url.pathname).toBe(flow.TEST_REDIRECT_URI)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('deny-state')
    expect(url.searchParams.get('code')).toBeNull()
    expect(await handle.db.select().from(oauthConsent).where(eq(oauthConsent.clientId, clientId)).all()).toEqual([])
  })

  it('refuses a consent whose signed query was altered', async () => {
    const person = await flow.signUp(options, email('tamper'))
    const clientId = await flow.registeredClientId(options)
    const location = (await flow.authorize(options, person.cookie, { clientId })).headers.get('location')!
    const tampered = location.replace(encodeURIComponent(flow.TEST_REDIRECT_URI), encodeURIComponent('http://127.0.0.1:47999/stolen'))
    const answered = await flow.consent(options, person.cookie, tampered, true)
    expect(answered.status).toBe(400)
  })
})

describe('consent every time', () => {
  it('shows the consent screen again to a client the person already approved, and never issues a code silently', async () => {
    const person = await flow.signUp(options, email('again'))
    const clientId = await flow.registeredClientId(options)
    await flow.connectClient(options, person.cookie, clientId)
    // Anyone on the machine can send this request with this client's id and a loopback redirect.
    const again = await flow.authorize(options, person.cookie, { clientId, redirectUri: 'http://127.0.0.1:55555/callback' })
    expect(again.headers.get('location')).toMatch(/^\/oauth\/consent\?.*prompt=consent/)
    expect(again.headers.get('location')).not.toContain('code=')
  })

  it('answers prompt=none with consent_required at the client, approved or not', async () => {
    const person = await flow.signUp(options, email('none'))
    const clientId = await flow.registeredClientId(options)
    for (const round of ['before approval', 'after approval']) {
      if (round === 'after approval') await flow.connectClient(options, person.cookie, clientId)
      const silent = await flow.authorize(options, person.cookie, { clientId, state: 'quiet', extra: { prompt: 'none' } })
      const location = new URL(silent.headers.get('location') ?? '', BASE)
      expect(location.origin + location.pathname, round).toBe(flow.TEST_REDIRECT_URI)
      expect(location.searchParams.get('error'), round).toMatch(/consent_required|interaction_required|login_required/)
      expect(location.searchParams.get('code'), round).toBeNull()
      expect(location.searchParams.get('state'), round).toBe('quiet')
    }
  })

  it('keeps refresh working: a refresh is not an authorization request', async () => {
    const { clientId, tokens } = await connected()
    const refreshed = await flow.tokenRequest(options, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token!, client_id: clientId, resource: RESOURCE })
    expect(refreshed.status).toBe(200)
  })
})

describe('scopes at authorize', () => {
  it('treats a request with no scope as both MCP scopes, shown on the consent screen', async () => {
    const person = await flow.signUp(options, email('noscope'))
    const clientId = await flow.registeredClientId(options)
    const { verifier, challenge } = flow.pkcePair()
    const query = flow.authorizeQuery(options, { clientId, challenge })
    query.delete('scope')
    const redirect = await options.fetch(`/api/auth/oauth2/authorize?${query}`, { headers: { cookie: person.cookie, accept: 'text/html' }, redirect: 'manual' })
    const location = redirect.headers.get('location')!
    expect(new URL(location, BASE).searchParams.get('scope')).toBe('gamut:read gamut:run offline_access')
    const code = new URL((await (await flow.consent(options, person.cookie, location, true)).json() as { url: string }).url).searchParams.get('code')!
    const tokens = await (await flow.tokenRequest(options, { grant_type: 'authorization_code', code, redirect_uri: flow.TEST_REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: RESOURCE })).json() as flow.IssuedTokens
    expect(tokens.scope).toBe('gamut:read gamut:run offline_access')
  })

  it('refuses a consent granting a scope the request did not ask for', async () => {
    const person = await flow.signUp(options, email('extra'))
    const clientId = await flow.registeredClientId(options)
    const location = (await flow.authorize(options, person.cookie, { clientId, scope: 'gamut:run' })).headers.get('location')!
    expect(new URL(location, BASE).searchParams.get('scope')).toBe('gamut:run offline_access')
    const answered = await flow.consent(options, person.cookie, location, true, 'gamut:read gamut:run offline_access')
    expect(answered.status).toBe(400)
  })
})

describe('the session cookie', () => {
  it('is SameSite=Lax and HttpOnly, so a cross-site frame of the consent page is signed out', async () => {
    const response = await options.fetch('/api/auth/sign-up/email', {
      method: 'POST', headers: { origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ email: email('cookie'), password: 'OauthFlowPassword123!', name: 'cookie' }),
    })
    const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith('better-auth.session_token='))!
    expect(session).toMatch(/SameSite=Lax/i)
    expect(session).toMatch(/HttpOnly/i)
  })
})

describe('unused registration cleanup', () => {
  it('deletes dynamic registrations nobody connected after a day, keeps the rest, and can run again', async () => {
    const person = await flow.signUp(options, email('cleanup'))
    const unused = await flow.registeredClientId(options, { client_name: 'Unused' })
    const fresh = await flow.registeredClientId(options, { client_name: 'Fresh' })
    const used = await flow.registeredClientId(options, { client_name: 'Used' })
    await flow.connectClient(options, person.cookie, used)
    const old = new Date(Date.now() - STALE_REGISTRATION_MS - 60_000)
    for (const clientId of [unused, used]) await handle.db.update(oauthClient).set({ createdAt: old }).where(eq(oauthClient.clientId, clientId)).run()
    // A metadata-document client is never removed here.
    await handle.db.insert(oauthClient).values({ id: 'cimd-row', clientId: 'https://example.com/c.json', clientDiscoveryId: 'cimd', redirectUris: '[]', createdAt: old }).run()

    expect(await deleteUnusedClientRegistrations()).toBeGreaterThanOrEqual(1)
    const left = new Set((await handle.db.select({ clientId: oauthClient.clientId }).from(oauthClient).all()).map((row) => row.clientId))
    expect(left.has(unused)).toBe(false)
    expect(left.has(fresh)).toBe(true)
    expect(left.has(used)).toBe(true)
    expect(left.has('https://example.com/c.json')).toBe(true)
    expect(await deleteUnusedClientRegistrations()).toBe(0)
  })
})

describe('open client registration', () => {
  it('registers a native client with a loopback redirect, and caps field sizes', async () => {
    expect((await flow.registerClient(options)).status).toBe(201)
    const tooLong = await flow.registerClient(options, { client_name: 'x'.repeat(DCR_LIMITS.maxNameChars + 1) })
    expect(tooLong.status).toBe(400)
    expect(await tooLong.json()).toMatchObject({ error: 'invalid_client_metadata' })
    const manyRedirects = await flow.registerClient(options, { redirect_uris: Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${40000 + i}/cb`) })
    expect(manyRedirects.status).toBe(400)
    const longUri = await flow.registerClient(options, { client_uri: `https://example.com/${'a'.repeat(DCR_LIMITS.maxUriChars)}` })
    expect(longUri.status).toBe(400)
    const huge = await flow.registerClient(options, { software_statement: 'x'.repeat(DCR_LIMITS.maxBodyBytes) })
    expect(huge.status).toBe(413)
  })

  it('limits registrations per client address in an hour', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7' }
    const statuses: number[] = []
    for (let i = 0; i < DCR_LIMITS.perClientPerHour + 1; i++) statuses.push((await flow.registerClient(options, {}, headers)).status)
    expect(statuses.slice(0, DCR_LIMITS.perClientPerHour).every((status) => status === 201)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
    // Another address is not held up by that one.
    expect((await flow.registerClient(options, {}, { 'x-forwarded-for': '203.0.113.8' })).status).toBe(201)
  })
})

describe('client ID metadata documents', () => {
  it('fetches nothing for a client_id that is not https on a public host', async () => {
    const person = await flow.signUp(options, email('cimd'))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      for (const clientId of [
        'http://example.com/client.json',
        'https://127.0.0.1/client.json',
        'https://localhost/client.json',
        'https://10.0.0.5/client.json',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/client.json',
        'https://user:pass@example.com/client.json',
      ]) {
        const response = await flow.authorize(options, person.cookie, { clientId })
        expect(response.headers.get('location') ?? '', clientId).not.toMatch(/^\/oauth\/consent/)
        expect(response.headers.get('location') ?? '', clientId).not.toContain('code=')
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('settings routes', () => {
  it('lets only an admin flip the switch', async () => {
    const admin = await flow.signUp(options, email('first-admin'))
    const member = await flow.signUp(options, email('member'))
    // Whoever signed up first in this file is the admin; make this one admin explicitly.
    await handle.db.update(user).set({ role: 'admin' }).where(eq(user.id, admin.userId)).run()
    await handle.db.update(user).set({ role: 'user' }).where(eq(user.id, member.userId)).run()
    const put = (cookie: string, enabled: boolean) => options.fetch('/api/mcp-server/enabled', {
      method: 'PUT', headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
    })
    expect((await put(member.cookie, false)).status).toBe(403)
    const off = await put(admin.cookie, false)
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ enabled: false, available: true, auth: 'oauth', endpointUrl: RESOURCE, token: null })
  })

  it('shows and revokes only the person\'s own clients', async () => {
    const alice = await connected('gamut:read gamut:run', email('alice'))
    const bob = await connected('gamut:read', email('bob'))
    const list = async (cookie: string) => (await (await options.fetch('/api/mcp-server/oauth/clients', { headers: { cookie } })).json() as { clients: Array<Record<string, unknown>> }).clients
    const aliceClients = await list(alice.cookie)
    expect(aliceClients).toHaveLength(1)
    expect(aliceClients[0]).toMatchObject({ clientId: alice.clientId, name: 'Flow Test Client', registration: 'dynamic', redirectHosts: ['127.0.0.1 (this computer)'], scopes: ['gamut:read', 'gamut:run'] })
    expect(aliceClients[0].lastActiveAt).toBeTruthy()
    expect((await list(bob.cookie)).map((client) => client.clientId)).toEqual([bob.clientId])

    // Bob cannot revoke Alice's client: nothing of hers changes.
    const attempt = await options.fetch('/api/mcp-server/oauth/clients/revoke', {
      method: 'POST', headers: { cookie: bob.cookie, origin: BASE, 'content-type': 'application/json' }, body: JSON.stringify({ clientId: alice.clientId }),
    })
    expect(attempt.status).toBe(404)
    expect((await mcpPost(initialize, alice.tokens.access_token)).status).toBe(200)
    expect(await handle.db.select().from(oauthRefreshToken).where(and(eq(oauthRefreshToken.userId, alice.userId), eq(oauthRefreshToken.clientId, alice.clientId))).all()).not.toHaveLength(0)
  })

  it('describes the client a consent screen is for, with the redirect host only when registered', async () => {
    const person = await flow.signUp(options, email('consent-info'))
    const clientId = await flow.registeredClientId(options, { client_name: '<img src=x onerror=alert(1)>' })
    const info = async (redirectUri: string) => (await options.fetch(`/api/mcp-server/oauth/consent-client?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}`, { headers: { cookie: person.cookie } })).json() as Promise<Record<string, unknown>>
    expect(await info('http://127.0.0.1:5555/callback')).toMatchObject({ name: '<img src=x onerror=alert(1)>', registration: 'dynamic', redirectHost: '127.0.0.1 (this computer)' })
    expect(await info('https://evil.example/callback')).toMatchObject({ redirectHost: null })
    expect((await options.fetch(`/api/mcp-server/oauth/consent-client?client_id=nope`, { headers: { cookie: person.cookie } })).status).toBe(404)
    expect((await options.fetch(`/api/mcp-server/oauth/consent-client?client_id=${clientId}`)).status).toBe(401)
  })
})
