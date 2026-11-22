/**
 * Open Dynamic Client Registration lets anyone add a client row (bounded per
 * hour, dcr-limits). A registration nobody ever connected is removed after a
 * day: a client registered dynamically (no Client ID Metadata Document) with
 * no consent and no refresh token, older than `STALE_REGISTRATION_MS`. One
 * conditional DELETE, safe to repeat. A client someone connected stays until
 * its last consent and refresh token go; a metadata-document client is
 * re-created from its document whenever it is used, so it is left alone.
 */
import { and, isNull, lt, notExists, eq } from 'drizzle-orm'
import { db } from '@shared/lib/db'
import { changesOf } from '@shared/lib/db/batch'
import { oauthClient, oauthConsent, oauthRefreshToken } from '@shared/lib/db/schema'
import { isAuthMode } from '@shared/lib/auth/mode'
import { PassTask, taskManager, type Service } from '@shared/lib/background-work'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'

export const STALE_REGISTRATION_MS = 24 * 60 * 60 * 1000
const INTERVAL_MS = 6 * 60 * 60 * 1000

/** Deletes unused dynamic registrations older than the cutoff; returns how many. */
export async function deleteUnusedClientRegistrations(now = Date.now()): Promise<number> {
  const result = await db.delete(oauthClient).where(and(
    isNull(oauthClient.clientDiscoveryId),
    lt(oauthClient.createdAt, new Date(now - STALE_REGISTRATION_MS)),
    notExists(db.select({ id: oauthConsent.id }).from(oauthConsent).where(eq(oauthConsent.clientId, oauthClient.clientId))),
    notExists(db.select({ id: oauthRefreshToken.id }).from(oauthRefreshToken).where(eq(oauthRefreshToken.clientId, oauthClient.clientId))),
  )).run()
  return changesOf(result)
}

export class McpClientCleanupService implements Service {
  readonly id = 'mcp-oauth-client-cleanup'
  readonly phase = 'background' as const
  private readonly cleanupTask = new PassTask('mcp-oauth.client-cleanup', () => deleteUnusedClientRegistrations().then(
    (deleted) => { if (deleted > 0) console.log(`[mcp-oauth] Removed ${deleted} unused client registrations`) },
    (error: unknown) => captureException(error, { tags: { area: 'mcp-oauth', op: 'client-cleanup' } }),
  ))
  readonly tasks = [this.cleanupTask]

  enabled(): boolean {
    return isAuthMode()
  }

  async start(): Promise<void> {
    await taskManager().ensureEvery(this.cleanupTask.type, this.cleanupTask.spec, { intervalMs: INTERVAL_MS, initialDelayMs: 60_000 })
  }

  stop(): void {
    background(taskManager().cancel(this.cleanupTask.type), { name: 'mcp-oauth-client-cleanup.cancel' })
  }
}
