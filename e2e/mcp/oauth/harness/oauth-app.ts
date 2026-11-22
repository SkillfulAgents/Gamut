/**
 * The auth-mode server the OAuth suite runs against, reached the way a
 * person's browser does: people signed up through Better Auth's own routes,
 * each request with that person's session cookie. The first person to sign up
 * on the fresh data dir is the admin.
 */
import type { McpServerStatusResponse } from '../../../../src/shared/lib/mcp-server/mcp-server-settings-schema'
import type { ConnectedMcpClient } from '../../../../src/shared/lib/mcp-server/oauth/connected-clients'

export const PASSWORD = 'McpOauthE2e-Password1'
/** The https host whose Client ID Metadata Documents the fixture serves (playwright.mcp-oauth.config.ts). */
export const CIMD_HOST = 'cimd.gamut-e2e.dev'

export function baseUrl(): string {
  const url = process.env.E2E_BASE_URL
  if (!url) throw new Error('E2E_BASE_URL is not set: run through playwright.mcp-oauth.config.ts')
  return url
}

export function mcpUrl(): string {
  return `${baseUrl()}/mcp`
}

export function cimdFixturePort(): number {
  return Number(process.env.MCP_OAUTH_CIMD_PORT ?? '3016')
}

export interface Person {
  name: string
  email: string
  id: string
  role: string | null
  cookie: string
}

function cookiesOf(response: Response): string {
  return response.headers.getSetCookie()
    .filter((value) => !/max-age=0(?:;|$)/i.test(value))
    .map((value) => value.split(';')[0])
    .join('; ')
}

async function authPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl()}/api/auth/${path}`, {
    method: 'POST',
    headers: { origin: baseUrl(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Signs the person up, or in when they already exist (a second spec in the same server run). */
export async function signUpOrIn(name: string, email: string): Promise<Person> {
  let response = await authPost('sign-up/email', { name, email, password: PASSWORD })
  if (response.status !== 200) response = await authPost('sign-in/email', { email, password: PASSWORD })
  if (response.status !== 200) throw new Error(`could not sign ${email} in: ${response.status} ${await response.text()}`)
  const body = await response.json() as { user: { id: string; role?: string | null } }
  return { name, email, id: body.user.id, role: body.user.role ?? null, cookie: cookiesOf(response) }
}

/**
 * A request with the person's session. Signing in in the browser (each
 * consent flow) counts against their concurrent-session cap, which can retire
 * the session this harness holds; a 401 signs in again once.
 */
export async function as<T>(person: Person, path: string, init: RequestInit = {}): Promise<T> {
  const send = () => fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { cookie: person.cookie, origin: baseUrl(), ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  })
  let response = await send()
  if (response.status === 401) {
    person.cookie = (await signUpOrIn(person.name, person.email)).cookie
    response = await send()
  }
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} as ${person.email} answered ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

export function setMcpEnabled(admin: Person, enabled: boolean): Promise<McpServerStatusResponse> {
  return as(admin, '/api/mcp-server/enabled', { method: 'PUT', body: JSON.stringify({ enabled }) })
}

export async function connectedClients(person: Person): Promise<ConnectedMcpClient[]> {
  return (await as<{ clients: ConnectedMcpClient[] }>(person, '/api/mcp-server/oauth/clients')).clients
}

let cast: { admin: Person; member: Person; outsider: Person } | null = null

/** The suite's people: the admin (signed up first), a member and a third person with no role on anything. */
export async function people(): Promise<{ admin: Person; member: Person; outsider: Person }> {
  if (cast) return cast
  const admin = await signUpOrIn('OAuth Admin', 'oauth-admin@example.com')
  if (admin.role !== 'admin') throw new Error(`the first person should be the admin, got role ${admin.role}`)
  const member = await signUpOrIn('OAuth Member', 'oauth-member@example.com')
  const outsider = await signUpOrIn('OAuth Outsider', 'oauth-outsider@example.com')
  for (const person of [admin, member, outsider]) {
    // The first-run wizard is not what these people came for.
    await as(person, '/api/user-settings', { method: 'PUT', body: JSON.stringify({ setupCompleted: true }) }).catch(() => undefined)
  }
  cast = { admin, member, outsider }
  return cast
}

export interface ApiAgent { slug: string; displaySlug: string; name: string }

async function findOrCreateAgent(owner: Person, name: string): Promise<ApiAgent> {
  const existing = (await as<ApiAgent[]>(owner, '/api/agents')).find((agent) => agent.name === name)
  return existing ?? as<ApiAgent>(owner, '/api/agents', { method: 'POST', body: JSON.stringify({ name }) })
}

async function grant(owner: Person, agent: ApiAgent, person: Person, role: 'user' | 'viewer'): Promise<void> {
  const response = await fetch(`${baseUrl()}/api/agents/${agent.slug}/access`, {
    method: 'POST',
    headers: { cookie: owner.cookie, origin: baseUrl(), 'content-type': 'application/json' },
    body: JSON.stringify({ userId: person.id, role, notify: false }),
  })
  // 409: granted by an earlier spec in the same server run.
  if (!response.ok && response.status !== 409) throw new Error(`granting ${role} on ${agent.slug} answered ${response.status}: ${await response.text()}`)
}

/** Three agents the admin owns: one the member may use, one the member may only view, one private to the admin. */
export async function seedAgents(): Promise<{ shared: ApiAgent; viewOnly: ApiAgent; private: ApiAgent }> {
  const { admin, member } = await people()
  const shared = await findOrCreateAgent(admin, 'OAuth Shared Agent')
  const viewOnly = await findOrCreateAgent(admin, 'OAuth View-only Agent')
  const privateAgent = await findOrCreateAgent(admin, 'OAuth Private Agent')
  await grant(admin, shared, member, 'user')
  await grant(admin, viewOnly, member, 'viewer')
  return { shared, viewOnly, private: privateAgent }
}
