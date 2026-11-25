/**
 * The installation token: the one bearer credential MCP clients present on
 * `/mcp` when the deployment has no auth mode (Electron, non-auth web). It is
 * an app record, created on first use with insert-if-absent, so every process
 * of the deployment agrees on one token, and it is read from the database on
 * every check: a regenerate in one process stops the old token in every other
 * one at once. Nothing here is cached.
 *
 * It is accepted on `/mcp` only. `/api/*` never reads it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { compareAndSetRecord, getOrCreateRecord, insertRecordIfAbsent, readStoredRecord, serializeRecordValue } from '@shared/lib/app-records/records'
import {
  MCP_INSTALLATION_TOKEN_PREFIX,
  MCP_INSTALLATION_TOKEN_RECORD_KEY,
  mcpInstallationTokenRecordSchema,
} from '@shared/lib/app-records/record-schemas'

function newToken(): string {
  return `${MCP_INSTALLATION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** The token, created on first use. */
export async function getOrCreateMcpInstallationToken(): Promise<string> {
  return getOrCreateRecord(MCP_INSTALLATION_TOKEN_RECORD_KEY, mcpInstallationTokenRecordSchema, newToken)
}

/** Replace the token; the old one stops working with this write. Returns the new token. */
export async function regenerateMcpInstallationToken(): Promise<string> {
  const token = newToken()
  const stored = serializeRecordValue(MCP_INSTALLATION_TOKEN_RECORD_KEY, token, mcpInstallationTokenRecordSchema)
  // A compare-and-set on the revision read: a concurrent regenerate makes this
  // one read again and replace whatever won, so the caller's token is the one stored.
  for (let attempt = 0; attempt < 10; attempt++) {
    // The stored text, not the parsed value: a value that no longer parses is replaced too.
    const current = await readStoredRecord(MCP_INSTALLATION_TOKEN_RECORD_KEY)
    const written = current
      ? await compareAndSetRecord(MCP_INSTALLATION_TOKEN_RECORD_KEY, current.revision, stored)
      : await insertRecordIfAbsent(MCP_INSTALLATION_TOKEN_RECORD_KEY, stored)
    if (written) return token
  }
  throw new Error('Could not replace the MCP installation token: it kept changing')
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Whether `presented` is the current token, compared in constant time (both
 * sides hashed first, so their lengths never differ). Creates the token when
 * there is none yet, which no presented value can match.
 */
export async function verifyMcpInstallationToken(presented: string): Promise<boolean> {
  const expected = await getOrCreateMcpInstallationToken()
  return timingSafeEqual(digest(presented), digest(expected))
}
