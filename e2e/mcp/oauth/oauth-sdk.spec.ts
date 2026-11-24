/**
 * The whole OAuth flow over real HTTP against an auth-mode server, with the
 * official MCP SDKs' own OAuth support and a real browser for the person:
 * 401 → resource metadata → authorization-server metadata → registration
 * (DCR with v1, a Client ID Metadata Document with v2) → authorize with PKCE,
 * signing in on Gamut's page and approving its consent screen → code →
 * tokens → tools, read and run, against the mock agent host → refresh →
 * disconnect in Settings → refused. Also: declining, a read-only grant and
 * the SDK's step-up, people without a role, and the admin switch.
 */
import { expect, test } from '@playwright/test'
import { decodeJwt } from 'jose'
import { EXPECTED_TOOL_NAMES } from '../harness/expected-tools'
import { MOCK_REPLY } from '../harness/seed'
import { baseUrl, connectedClients, mcpUrl, people, seedAgents, setMcpEnabled, signUpOrIn, as, CIMD_HOST, type Person } from './harness/oauth-app'
import { consentInBrowser, useSession } from './harness/browser-consent'
import { connectWithOAuth, isUnauthorized, MemoryOAuthProvider, SDK_REDIRECT_URL, type OAuthSession, type SdkKind } from './harness/sdk-oauth'
import { startCimdFixture, type CimdFixture } from './harness/cimd-fixture'

test.describe.configure({ mode: 'serial' })

let cimd: CimdFixture
let agents: Awaited<ReturnType<typeof seedAgents>>
let cast: Awaited<ReturnType<typeof people>>

test.beforeAll(async () => {
  cimd = await startCimdFixture()
  cast = await people()
  agents = await seedAgents()
  await setMcpEnabled(cast.admin, true)
})

test.afterAll(async () => {
  await cimd?.close()
})

function resultJson(result: Awaited<ReturnType<OAuthSession['callTool']>>): any {
  if (result.isError) throw new Error(`Tool error: ${result.content.map((block) => block.text).join('\n')}`)
  return JSON.parse(result.content.find((block) => block.type === 'text')?.text ?? 'null')
}

function toolError(result: Awaited<ReturnType<OAuthSession['callTool']>>): string {
  expect(result.isError, 'a tool error').toBe(true)
  return result.content.map((block) => block.text).join('\n')
}

test('discovery: the 401 points at RFC 9728 metadata, which points at the RFC 8414 server metadata', async () => {
  const challenge = await fetch(mcpUrl(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' })
  expect(challenge.status).toBe(401)
  const header = challenge.headers.get('www-authenticate') ?? ''
  expect(header).toBe(`Bearer resource_metadata="${baseUrl()}/.well-known/oauth-protected-resource/mcp", scope="gamut:read gamut:run"`)
  const prm = await (await fetch(`${baseUrl()}/.well-known/oauth-protected-resource/mcp`)).json()
  expect(prm).toMatchObject({ resource: mcpUrl(), authorization_servers: [baseUrl()], scopes_supported: ['gamut:read', 'gamut:run'] })
  const as = await (await fetch(`${baseUrl()}/.well-known/oauth-authorization-server`)).json()
  expect(as).toMatchObject({
    issuer: baseUrl(),
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ['S256'],
    registration_endpoint: `${baseUrl()}/api/auth/oauth2/register`,
  })
})

test.describe('v1 SDK with Dynamic Client Registration, as the member', () => {
  const provider = new MemoryOAuthProvider('Gamut E2E v1 (DCR)')
  let mcp: OAuthSession

  test.afterAll(async () => {
    await mcp?.close().catch(() => undefined)
  })

  test('signs in through the browser: sign-in page, consent screen, code, tokens', async ({ browser }) => {
    mcp = await connectWithOAuth('v1', mcpUrl(), provider, async (authorizationUrl) => {
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${baseUrl()}/api/auth/oauth2/authorize`)
      expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
      expect(authorizationUrl.searchParams.get('resource')).toBe(mcpUrl())
      expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(SDK_REDIRECT_URL)
      const { callback, signedIn } = await consentInBrowser(browser, authorizationUrl.href, cast.member, {
        inspect: async (page) => {
          await expect(page.getByTestId('mcp-consent-client-name')).toHaveText('Gamut E2E v1 (DCR)')
          await expect(page.getByTestId('mcp-consent-redirect-host')).toHaveText('127.0.0.1 (this computer)')
          await expect(page.getByTestId('mcp-consent-verification')).toContainText('cannot verify this app')
          await expect(page.getByTestId('mcp-consent-run-warning')).toContainText('act with the accounts connected to them')
        },
      })
      expect(signedIn, 'the person signed in on Gamut\'s page first').toBe(true)
      return callback
    })
    // DCR: a server-issued id, not a URL.
    expect(provider.clientId).toMatch(/^[A-Za-z]{32}$/)
    const claims = decodeJwt(provider.accessToken!)
    expect(claims).toMatchObject({ aud: mcpUrl(), iss: baseUrl(), sub: cast.member.id, azp: provider.clientId })
    expect(String(claims.scope).split(' ')).toEqual(expect.arrayContaining(['gamut:read', 'gamut:run']))
    expect(provider.refreshToken).toMatch(/^gamut_rt_/)
  })

  test('lists exactly the Gamut tools and reads what the member may see', async () => {
    const { tools } = await mcp.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES)
    const listed = resultJson(await mcp.callTool('list_agents'))
    const slugs = (listed.agents as Array<{ slug: string }>).map((agent) => agent.slug)
    expect(slugs).toEqual(expect.arrayContaining([agents.shared.displaySlug, agents.viewOnly.displaySlug]))
    expect(slugs).not.toContain(agents.private.displaySlug)
  })

  test('runs an agent it may use; refuses one it may only view and one it cannot see', async ({ page }) => {
    const ran = resultJson(await mcp.callTool('invoke_agent', { agent: agents.shared.displaySlug, prompt: 'Hello from an OAuth client', wait_seconds: 30 }))
    expect(ran).toMatchObject({ status: 'completed', last_message: MOCK_REPLY })
    expect(toolError(await mcp.callTool('invoke_agent', { agent: agents.viewOnly.displaySlug, prompt: 'Not allowed' }))).toMatch(/role|permission|not allowed|cannot/i)
    expect(toolError(await mcp.callTool('invoke_agent', { agent: agents.private.displaySlug, prompt: 'Not visible' }))).toMatch(/not found|no agent|unknown|do not have access/i)

    // The audit row and the session both name the OAuth client, in the 2025
    // era too, which carries no client name of its own on a stateless server.
    const audit = await as<{ entries: Array<{ userId: string; details: string | null }> }>(cast.admin, '/api/audit-log?object=mcp_tool&limit=20')
    const row = audit.entries.find((entry) => entry.userId === cast.member.id && JSON.parse(entry.details ?? '{}').tool === 'invoke_agent')
    expect(JSON.parse(row?.details ?? '{}')).toMatchObject({ client: 'Gamut E2E v1 (DCR)', credential: 'oauth' })
    await useSession(page.context(), cast.member)
    await page.goto(`${baseUrl()}/agents/${agents.shared.slug}/sessions/${ran.session_id}`)
    await expect(page.getByTestId('mcp-session-banner')).toContainText('Session started through MCP from "Gamut E2E v1 (DCR)"', { timeout: 30_000 })
  })

  test('refreshes when the access token is refused, rotating the refresh token', async () => {
    const before = { access: provider.accessToken, refresh: provider.refreshToken, saves: provider.savedTokens.length }
    provider.spoilAccessToken()
    const listed = resultJson(await mcp.callTool('list_agents'))
    expect(listed.agents.length).toBeGreaterThan(0)
    expect(provider.savedTokens.length).toBe(before.saves + 1)
    expect(provider.accessToken).not.toBe(before.access)
    expect(provider.refreshToken).toMatch(/^gamut_rt_/)
    expect(provider.refreshToken).not.toBe(before.refresh)
  })

  test('disconnecting it in Settings → MCP Server stops it at once', async ({ page }) => {
    await useSession(page.context(), cast.member)
    await page.goto(`${baseUrl()}/settings/mcp-server`)
    const row = page.getByTestId('mcp-connected-client').filter({ hasText: 'Gamut E2E v1 (DCR)' })
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Read · Run agents')
    await row.getByTestId('mcp-connected-client-revoke').click()
    await page.getByTestId('mcp-connected-client-revoke-confirm').click()
    await expect(row).toHaveCount(0)
    expect((await connectedClients(cast.member)).some((client) => client.clientId === provider.clientId)).toBe(false)

    // The access token is refused; the refresh token is dead (invalid_grant);
    // so the SDK goes back to the person for authorization.
    const asksBefore = provider.authorizationUrls.length
    const refused = await mcp.callTool('list_agents').then(() => null, (error: unknown) => error)
    expect(refused, 'the call fails').not.toBeNull()
    expect(isUnauthorized(refused), String(refused)).toBe(true)
    expect(provider.authorizationUrls.length).toBe(asksBefore + 1)
  })
})

test.describe('v2 SDK with a Client ID Metadata Document', () => {
  test('the server fetches the document, the consent screen names its host, and the client connects', async ({ browser }) => {
    const clientId = cimd.serve('v2-client', {
      client_name: 'Gamut E2E v2 (CIMD)',
      redirect_uris: [SDK_REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    })
    const provider = new MemoryOAuthProvider('Gamut E2E v2 (CIMD)', clientId)
    const mcp = await connectWithOAuth('v2', mcpUrl(), provider, async (authorizationUrl) => {
      expect(authorizationUrl.searchParams.get('client_id')).toBe(clientId)
      const { callback } = await consentInBrowser(browser, authorizationUrl.href, cast.member, {
        inspect: async (page) => {
          await expect(page.getByTestId('mcp-consent-client-name')).toHaveText('Gamut E2E v2 (CIMD)')
          await expect(page.getByTestId('mcp-consent-verification')).toContainText(CIMD_HOST)
        },
      })
      return callback
    })
    try {
      expect(cimd.fetched).toContain('/v2-client.json')
      expect(decodeJwt(provider.accessToken!).azp).toBe(clientId)
      const { tools } = await mcp.listTools()
      expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES)
      const guide = await mcp.callTool('get_guide')
      expect(guide.isError).toBeFalsy()
      const listed = await connectedClients(cast.member)
      expect(listed.find((client) => client.clientId === clientId)).toMatchObject({ registration: 'metadata-document', documentHost: CIMD_HOST })
    } finally {
      await mcp.close()
    }
  })
})

/** One person's connection (v1 unless said), approved in the browser, with the options given. */
async function connect(browser: Parameters<typeof consentInBrowser>[0], person: Person, name: string, options: Parameters<typeof consentInBrowser>[3] = {}, kind: SdkKind = 'v1') {
  const provider = new MemoryOAuthProvider(name)
  const mcp = await connectWithOAuth(kind, mcpUrl(), provider, async (url) => (await consentInBrowser(browser, url.href, person, options)).callback)
  return { provider, mcp }
}

test('declining at consent sends access_denied back and connects nothing', async ({ browser }) => {
  const provider = new MemoryOAuthProvider('Gamut E2E declined')
  let callback: URL | null = null
  const attempt = await connectWithOAuth('v1', mcpUrl(), provider, async (url) => {
    callback = (await consentInBrowser(browser, url.href, cast.member, { deny: true })).callback
    return callback
  }).then(() => null, (error: unknown) => error)
  expect(String(attempt)).toMatch(/without a code/)
  expect(callback!.searchParams.get('error')).toBe('access_denied')
  expect((await connectedClients(cast.member)).some((client) => client.clientId === provider.clientId)).toBe(false)
})

for (const kind of ['v1', 'v2'] as const) {
  test(`${kind} SDK, read-only grant: reads; a run tool is a 403 insufficient_scope naming gamut:run, and the SDK tries to step up`, async ({ browser }) => {
    const { provider, mcp } = await connect(browser, cast.member, `Gamut E2E read-only ${kind}`, { readOnly: true }, kind)
    try {
      expect(String(decodeJwt(provider.accessToken!).scope)).not.toContain('gamut:run')
      expect(resultJson(await mcp.callTool('list_agents')).agents.length).toBeGreaterThan(0)
      const asks = provider.authorizationUrls.length
      const saves = provider.savedTokens.length
      const refused = await mcp.callTool('invoke_agent', { agent: agents.shared.displaySlug, prompt: 'Run me' }).then(() => null, (error: unknown) => error)
      expect(refused, 'the run call does not go through').not.toBeNull()
      const stepUp = { error: String(refused), authorizationRequests: provider.authorizationUrls.length - asks, tokenSaves: provider.savedTokens.length - saves, scope: provider.authorizationUrls.at(-1)?.searchParams.get('scope') ?? null }
      await test.info().attach(`step-up-${kind}.json`, { body: JSON.stringify(stepUp, null, 2), contentType: 'application/json' })
      if (kind === 'v1') {
        // v1 answers the 403 by refreshing, which cannot widen a grant, and
        // gives up on the second 403: the call fails with that message.
        expect(stepUp.error).toMatch(/403 after trying upscoping/)
        expect(stepUp.authorizationRequests).toBe(0)
      } else {
        // v2 goes back to the person for the wider scope.
        expect(stepUp.authorizationRequests).toBe(1)
        expect(stepUp.scope).toContain('gamut:run')
      }
    } finally {
      await mcp.close()
    }
  })
}

test('someone with no role on the admin\'s agents sees none of them through their own connection', async ({ browser }) => {
  const { mcp } = await connect(browser, cast.outsider, 'Gamut E2E outsider')
  try {
    const slugs = (resultJson(await mcp.callTool('list_agents')).agents as Array<{ slug: string }>).map((agent) => agent.slug)
    for (const agent of [agents.shared, agents.viewOnly, agents.private]) expect(slugs).not.toContain(agent.displaySlug)
    expect(toolError(await mcp.callTool('list_sessions', { agent: agents.shared.displaySlug }))).toMatch(/not found|no agent|unknown|do not have access/i)
    expect(toolError(await mcp.callTool('invoke_agent', { agent: agents.shared.displaySlug, prompt: 'Not mine' }))).toMatch(/not found|no agent|unknown|do not have access/i)
  } finally {
    await mcp.close()
  }
})

test('the admin switch: off, the endpoint and its discovery answer 404; on again, the same grant works and refreshes', async ({ browser }) => {
  const { provider, mcp } = await connect(browser, cast.admin, 'Gamut E2E admin')
  let reEnabled = false
  try {
    await setMcpEnabled(cast.admin, false)
    expect((await fetch(`${baseUrl()}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404)
    const off = await mcp.callTool('get_guide').then(() => null, (error: unknown) => error)
    expect(String(off)).toMatch(/404|Not found/)
    // A member cannot turn it back on. (A fresh sign-in: the browser sign-ins
    // above count against the member's concurrent sessions.)
    const member = await signUpOrIn(cast.member.name, cast.member.email)
    const memberTry = await fetch(`${baseUrl()}/api/mcp-server/enabled`, { method: 'PUT', headers: { cookie: member.cookie, origin: baseUrl(), 'content-type': 'application/json' }, body: '{"enabled":true}' })
    expect(memberTry.status).toBe(403)
    // On again: the client kept its grant through the 404s. The same
    // connection works without signing in again, and refreshes.
    await setMcpEnabled(cast.admin, true)
    reEnabled = true
    const asks = provider.authorizationUrls.length
    expect((await mcp.callTool('get_guide')).isError).toBeFalsy()
    const refreshToken = provider.refreshToken
    provider.spoilAccessToken()
    expect((await mcp.callTool('get_guide')).isError).toBeFalsy()
    expect(provider.refreshToken).not.toBe(refreshToken)
    expect(provider.authorizationUrls.length).toBe(asks)
  } finally {
    if (!reEnabled) await setMcpEnabled(cast.admin, true)
    await mcp.close().catch(() => undefined)
  }
})
