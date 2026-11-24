/**
 * The resource-server half of `/mcp` in auth mode: an OAuth access token
 * becomes the person and client a call acts for, or the response refusing it.
 *
 * In order:
 * 1. The token is a JWT this deployment signed: signature against the `jwt`
 *    plugin's JWKS (read in process, refetched when an unknown `kid` shows a
 *    rotation; the key set holds only asymmetric keys, so `alg: none` and
 *    HMAC-with-the-public-key confusion cannot verify), `iss` this deployment,
 *    `aud` exactly the `/mcp` URL (one audience, not a list holding it), `exp` not passed, `azp` (the client) and
 *    `scope` present. A DPoP-bound token needs its proof (Better Auth's
 *    verifier). A session token, the installation token or a JWT for any
 *    other audience fails here.
 * 2. The person still has an active account: the row exists (a removed
 *    person's token dies with them), is not `invited` and is not banned
 *    (banned includes awaiting admin approval).
 * 3. The grant still stands: the person's consent for that client exists and
 *    is not newer than the token, and the client is not disabled. Revoking a
 *    client (Settings → MCP Server) deletes the consent, so the next request
 *    with an access token issued before it is refused at once, not when the
 *    token expires; reconnecting makes a new consent that old tokens predate.
 *
 * That is two reads per request (keys, then person, consent and client in one
 * query), the price of revocation taking effect immediately.
 */
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { isAPIError } from 'better-auth/api'
import { createDpopReplayStore, requestToResourceInput, verifyAccessTokenRequest } from 'better-auth/oauth2'
import type { JWTPayload } from 'jose'
import { db } from '@shared/lib/db'
import { oauthClient, oauthConsent, user } from '@shared/lib/db/schema'
import { getAuth } from '@shared/lib/auth'
import type { McpCallContext } from '../context'
import type { McpToolScope } from '../tool-definition'
import { oauthUnauthorized } from './challenge'
import { canServeMcpOAuth, mcpResourceFor, OAUTH_SCOPE_FOR } from './oauth-config'
import { MCP_ACCESS_TOKEN_ALG, mcpIssuerFor } from './oauth-plugins'

export type OAuthMcpAuthentication = { ok: true; ctx: McpCallContext } | { ok: false; response: Response }

const CLIENT_NAME_MAX_CHARS = 100

function bearerTokenOf(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) return null
  const match = /^(?:Bearer|DPoP)[ \t]+(\S+)[ \t]*$/i.exec(header)
  return match ? match[1] : null
}

/** The deployment's base URL as the authorization server knows it. */
export async function mcpAuthorizationBaseUrl(): Promise<string> {
  const auth = await getAuth()
  return String(auth.options.baseURL).replace(/\/+$/, '')
}

function toolScopesOf(scopeClaim: unknown): McpToolScope[] {
  const granted = new Set(typeof scopeClaim === 'string' ? scopeClaim.split(' ') : [])
  return (Object.keys(OAUTH_SCOPE_FOR) as McpToolScope[]).filter((scope) => granted.has(OAUTH_SCOPE_FOR[scope]))
}

type Verified = { claims: JWTPayload } | { refused: string }

async function verifiedClaims(request: Request, baseUrl: string): Promise<Verified> {
  const auth = await getAuth()
  const authContext = await auth.$context
  try {
    const claims = await verifyAccessTokenRequest(requestToResourceInput(request), {
      verifyOptions: {
        issuer: mcpIssuerFor(baseUrl),
        audience: mcpResourceFor(baseUrl),
        algorithms: [MCP_ACCESS_TOKEN_ALG],
        requiredClaims: ['sub', 'azp', 'scope', 'iat', 'exp'],
      },
      jwksFetch: async () => (await auth.api.getJwks()) as never,
      jwksCacheKey: auth,
      dpop: { replayStore: createDpopReplayStore(authContext) },
    })
    // `aud` is exactly the /mcp URL: a token for several audiences could be
    // replayed at the others, and this server issues none.
    const audience = Array.isArray(claims.aud) && claims.aud.length === 1 ? claims.aud[0] : claims.aud
    if (audience !== mcpResourceFor(baseUrl)) return { refused: 'The access token is not for this server. Sign in again.' }
    return { claims }
  } catch (error) {
    // A token the verifier refuses is the caller's problem; anything else
    // (the key store unreachable) is ours, and a 500 says so.
    if (isAPIError(error) && error.status === 'UNAUTHORIZED') return { refused: 'The access token is not valid for this server. Sign in again.' }
    throw error
  }
}

interface GrantRow {
  status: string
  role: string | null
  banned: boolean | null
  banExpires: Date | null
  consentCreatedAt: Date | null
  /** The consent's scopes as Better Auth stores `string[]` on SQLite: JSON text. */
  consentScopes: string | null
  clientId: string | null
  clientName: string | null
  clientDisabled: boolean | null
}

async function grantOf(userId: string, clientId: string): Promise<GrantRow | undefined> {
  return db.select({
    status: user.status,
    role: user.role,
    banned: user.banned,
    banExpires: user.banExpires,
    consentCreatedAt: oauthConsent.createdAt,
    consentScopes: oauthConsent.scopes,
    clientId: oauthClient.clientId,
    clientName: oauthClient.name,
    clientDisabled: oauthClient.disabled,
  })
    .from(user)
    .leftJoin(oauthConsent, and(eq(oauthConsent.userId, user.id), eq(oauthConsent.clientId, clientId)))
    .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .where(eq(user.id, userId))
    .orderBy(desc(oauthConsent.createdAt))
    .limit(1)
    .get()
}

const consentScopesSchema = z.array(z.string())

/**
 * What the call may do: the token's scopes, cut down to what the person's
 * consent for this client grants now. A re-consent updates the consent row in
 * place (its `createdAt` stays), and neither a refresh nor an issued token
 * looks at it again: a token issued for read+run on one device keeps both
 * after the person re-approves the same client with read only elsewhere,
 * unless this intersection drops run. A wider re-consent cannot widen an old
 * token either: the token's own scopes are the ceiling.
 */
export function effectiveScopes(tokenScope: unknown, consentScopes: string | null): McpToolScope[] {
  let granted: string[] = []
  try {
    const parsed = consentScopesSchema.safeParse(JSON.parse(consentScopes ?? '[]'))
    if (parsed.success) granted = parsed.data
  } catch {
    granted = []
  }
  const consented = new Set(toolScopesOf(granted.join(' ')))
  return toolScopesOf(tokenScope).filter((scope) => consented.has(scope))
}

function isBanned(row: GrantRow, now: number): boolean {
  if (!row.banned) return false
  return !row.banExpires || row.banExpires.getTime() > now
}

export function displayClientName(name: string | null, clientId: string): string {
  const trimmed = name?.trim()
  return (trimmed || clientId).slice(0, CLIENT_NAME_MAX_CHARS)
}

/** Authenticates one `/mcp` request in auth mode. `publicBaseUrl` is where links point. */
export async function authenticateOAuthMcpRequest(request: Request): Promise<OAuthMcpAuthentication> {
  const baseUrl = await mcpAuthorizationBaseUrl()
  if (!canServeMcpOAuth(baseUrl)) {
    return {
      ok: false,
      response: new Response(JSON.stringify({
        error: 'MCP sign-in needs this workspace to be served over https. Ask an administrator to set its public https address.',
      }), { status: 503, headers: { 'Content-Type': 'application/json' } }),
    }
  }
  const token = bearerTokenOf(request)
  if (!token) return { ok: false, response: oauthUnauthorized(baseUrl, false, 'Sign in to Gamut to use this server.') }

  const verified = await verifiedClaims(request, baseUrl)
  if ('refused' in verified) return { ok: false, response: oauthUnauthorized(baseUrl, true, verified.refused) }
  const { claims } = verified
  const userId = String(claims.sub)
  const clientId = String(claims.azp)
  const issuedAtMs = Number(claims.iat) * 1000

  const grant = await grantOf(userId, clientId)
  if (!grant) return { ok: false, response: oauthUnauthorized(baseUrl, true, 'This Gamut account no longer exists.') }
  if (grant.status === 'invited' || isBanned(grant, Date.now())) {
    return { ok: false, response: oauthUnauthorized(baseUrl, true, 'This Gamut account is not active.') }
  }
  if (!grant.consentCreatedAt || !grant.clientId || grant.consentCreatedAt.getTime() > issuedAtMs) {
    return { ok: false, response: oauthUnauthorized(baseUrl, true, 'This connection was disconnected in Gamut. Sign in again to reconnect.') }
  }
  if (grant.clientDisabled) return { ok: false, response: oauthUnauthorized(baseUrl, true, 'This client was disabled in Gamut.') }

  return {
    ok: true,
    ctx: {
      userId,
      isAdmin: grant.role === 'admin',
      publicBaseUrl: baseUrl,
      credential: { kind: 'oauth', clientId, clientName: displayClientName(grant.clientName, clientId) },
      scopes: effectiveScopes(claims.scope, grant.consentScopes),
    },
  }
}
