/**
 * Analytics of the MCP authorization server (consent and disconnect), sent
 * through `trackServerEvent`, which reads consent itself:
 *
 * - `mcp_client_connected` { client_name, registration, scopes, first_connection }
 *   once per accepted consent the provider recorded (not per token or refresh);
 * - `mcp_consent_denied` { registration } when the person declines;
 * - `mcp_client_disconnected` { client_name, registration } when a person
 *   disconnects a client in Settings (sent by the route).
 *
 * Never a client id (a CIMD one is a URL), redirect URI, host, person, token
 * or code. The lookups these need run in the background: an event never
 * fails or delays the OAuth response.
 */
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@shared/lib/db'
import { oauthClient, oauthConsent } from '@shared/lib/db/schema'
import { trackServerEvent } from '@shared/lib/analytics/server-analytics'
import { background } from '@shared/lib/background'
import { displayClientName } from './access-token'
import { MCP_OAUTH_SCOPES } from './oauth-config'

export type ClientRegistration = 'metadata-document' | 'dynamic'

const scopesSchema = z.array(z.string())

function mcpScopesOf(stored: string | null): string[] {
  try {
    const parsed = scopesSchema.safeParse(JSON.parse(stored ?? '[]'))
    return parsed.success ? parsed.data.filter((scope) => (MCP_OAUTH_SCOPES as readonly string[]).includes(scope)) : []
  } catch {
    return []
  }
}

export async function clientFacts(clientId: string): Promise<{ client_name: string; registration: ClientRegistration } | null> {
  const row = await db.select({ name: oauthClient.name, discoveryId: oauthClient.clientDiscoveryId }).from(oauthClient).where(eq(oauthClient.clientId, clientId)).get()
  if (!row) return null
  return { client_name: displayClientName(row.name, clientId), registration: row.discoveryId ? 'metadata-document' : 'dynamic' }
}

/** After an accepted consent. `userId` when the endpoint knew the session; else the client's most recent consent. */
export function trackClientConnected(clientId: string, userId: string | undefined): void {
  background(async () => {
    try {
      const facts = await clientFacts(clientId)
      const consent = await db.select({ scopes: oauthConsent.scopes, createdAt: oauthConsent.createdAt, updatedAt: oauthConsent.updatedAt })
        .from(oauthConsent)
        .where(userId ? and(eq(oauthConsent.clientId, clientId), eq(oauthConsent.userId, userId)) : eq(oauthConsent.clientId, clientId))
        .orderBy(desc(oauthConsent.updatedAt))
        .limit(1)
        .get()
      if (!facts || !consent) return
      // The provider writes createdAt = updatedAt on a new consent and moves only updatedAt on an existing one.
      const first = (consent.createdAt?.getTime() ?? 0) === (consent.updatedAt?.getTime() ?? -1)
      trackServerEvent('mcp_client_connected', { ...facts, scopes: mcpScopesOf(consent.scopes), first_connection: first })
    } catch {
      // Analytics never breaks sign-in.
    }
  }, { name: 'mcp-oauth.track-connected' })
}

export function trackConsentDenied(clientId: string): void {
  background(async () => {
    try {
      const facts = await clientFacts(clientId)
      if (facts) trackServerEvent('mcp_consent_denied', { registration: facts.registration })
    } catch {
      // Analytics never breaks sign-in.
    }
  }, { name: 'mcp-oauth.track-denied' })
}
