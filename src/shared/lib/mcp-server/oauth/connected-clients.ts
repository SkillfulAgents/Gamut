/**
 * A person's connected MCP clients (Settings → MCP Server) and what the
 * consent screen shows about a client. A connection is the person's consent
 * to a client; revoking it deletes the consent and every token the client
 * holds for the person, in one batch:
 *
 * - refresh tokens: the client can no longer get new access tokens
 *   (`invalid_grant`);
 * - access tokens: JWTs, so there is nothing to delete, but each `/mcp`
 *   request checks the consent (access-token.ts), so the next request is
 *   refused.
 *
 * Only the person's own rows are ever read or touched: every query is keyed
 * by the user id of the session asking.
 */
import { and, desc, eq, max } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { batch } from '@shared/lib/db/batch'
import { oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from '@shared/lib/db/schema'
import { displayClientName } from './access-token'
import { MCP_OAUTH_SCOPES } from './oauth-config'

const stringListSchema = z.array(z.string())

/** Better Auth stores `string[]` as JSON text on SQLite. */
function parseList(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = stringListSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** `host[:port]` of each redirect URI, for display. A loopback redirect shows as `localhost`-style host with its port dropped (any port is accepted). */
export function redirectHostsOf(redirectUris: readonly string[]): string[] {
  const hosts = new Set<string>()
  for (const uri of redirectUris) {
    const url = URL.parse(uri)
    if (!url) continue
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    hosts.add(loopback ? `${url.hostname} (this computer)` : url.protocol === 'http:' || url.protocol === 'https:' ? url.host : `${url.protocol}//`)
  }
  return [...hosts]
}

/** How the client told us who it is: its own HTTPS document (CIMD), or a registration anyone can make (DCR). */
export type ClientRegistrationKind = 'metadata-document' | 'dynamic'

export interface ConnectedMcpClient {
  clientId: string
  name: string
  registration: ClientRegistrationKind
  /** For a metadata-document client: the host its `client_id` URL names (which it controls). */
  documentHost: string | null
  redirectHosts: string[]
  scopes: string[]
  connectedAt: string | null
  /** When the client last got a token for this person (it does at least every 15 minutes while in use). */
  lastActiveAt: string | null
}

function registrationOf(clientId: string, discoveryId: string | null): { registration: ClientRegistrationKind; documentHost: string | null } {
  if (!discoveryId) return { registration: 'dynamic', documentHost: null }
  return { registration: 'metadata-document', documentHost: URL.parse(clientId)?.host ?? null }
}

export async function listConnectedClients(userId: string): Promise<ConnectedMcpClient[]> {
  const lastToken = db.select({ clientId: oauthRefreshToken.clientId, at: max(oauthRefreshToken.createdAt).as('last_at') })
    .from(oauthRefreshToken)
    .where(eq(oauthRefreshToken.userId, userId))
    .groupBy(oauthRefreshToken.clientId)
    .as('last_token')
  const rows = await db.select({
    clientId: oauthConsent.clientId,
    scopes: oauthConsent.scopes,
    connectedAt: oauthConsent.createdAt,
    name: oauthClient.name,
    discoveryId: oauthClient.clientDiscoveryId,
    redirectUris: oauthClient.redirectUris,
    lastActiveAt: lastToken.at,
  })
    .from(oauthConsent)
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
    .leftJoin(lastToken, eq(lastToken.clientId, oauthConsent.clientId))
    .where(eq(oauthConsent.userId, userId))
    .orderBy(desc(oauthConsent.createdAt))
    .all()
  return rows.map((row) => ({
    clientId: row.clientId,
    name: displayClientName(row.name, row.clientId),
    ...registrationOf(row.clientId, row.discoveryId),
    redirectHosts: redirectHostsOf(parseList(row.redirectUris)),
    scopes: parseList(row.scopes).filter((scope) => (MCP_OAUTH_SCOPES as readonly string[]).includes(scope)),
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastActiveAt: lastActiveIso(row.lastActiveAt),
  }))
}

/** `max()` over a timestamp column comes back as the stored epoch ms. */
function lastActiveIso(value: unknown): string | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Number(value)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null
}

/** Disconnects a client from this person. Returns whether there was a connection. */
export async function revokeConnectedClient(userId: string, clientId: string): Promise<boolean> {
  const existing = await db.select({ id: oauthConsent.id }).from(oauthConsent)
    .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId))).limit(1).get()
  // Access-token rows first: they reference refresh-token rows.
  await batch([
    db.delete(oauthAccessToken).where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId))),
    db.delete(oauthRefreshToken).where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId))),
    db.delete(oauthConsent).where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId))),
  ])
  return Boolean(existing)
}

export interface ConsentClientInfo {
  clientId: string
  name: string
  registration: ClientRegistrationKind
  documentHost: string | null
  /** Where this request will return the person: the host of the `redirect_uri` it names, when registered for the client. */
  redirectHost: string | null
  redirectHosts: string[]
}

/**
 * What the consent screen shows about the client asking. The redirect host is
 * shown only when the URI is one the client registered (the provider has
 * already refused any other before sending the person here).
 */
export async function consentClientInfo(clientId: string, redirectUri: string | null): Promise<ConsentClientInfo | null> {
  const row = await db.select({ clientId: oauthClient.clientId, name: oauthClient.name, discoveryId: oauthClient.clientDiscoveryId, redirectUris: oauthClient.redirectUris, disabled: oauthClient.disabled })
    .from(oauthClient).where(eq(oauthClient.clientId, clientId)).get()
  if (!row || row.disabled) return null
  const registered = parseList(row.redirectUris)
  const requested = redirectUri && matchesRegistered(redirectUri, registered) ? redirectUri : null
  return {
    clientId: row.clientId,
    name: displayClientName(row.name, row.clientId),
    ...registrationOf(row.clientId, row.discoveryId),
    redirectHost: requested ? redirectHostsOf([requested])[0] ?? null : null,
    redirectHosts: redirectHostsOf(registered),
  }
}

/** Exact match, or a loopback redirect differing only in port (RFC 8252 §7.3), as the provider accepts. */
function matchesRegistered(uri: string, registered: readonly string[]): boolean {
  if (registered.includes(uri)) return true
  const url = URL.parse(uri)
  if (!url || url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return false
  return registered.some((candidate) => {
    const other = URL.parse(candidate)
    return !!other && other.protocol === url.protocol && other.hostname === url.hostname && other.pathname === url.pathname && other.search === url.search
  })
}
