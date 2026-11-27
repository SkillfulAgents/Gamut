/**
 * Cloudflare D1, next to better-sqlite3.ts and libsql.ts. D1 runs batches and has no interactive
 * transaction, so it refuses the default migrator, which runs every pending migration in one
 * transaction. migrateD1 applies them as one batch instead, atomic as that transaction is. The
 * entry point runs it as its own step and opens the database with `migrate: false`.
 */
import { drizzle } from 'drizzle-orm/d1'
import type { MigrationMeta } from 'drizzle-orm/migrator'
import * as schema from '../schema'
import { MIGRATIONS_TABLE } from '../open-database'
import type { DatabaseDriver } from './types'

/** The part of a Workers D1 binding this file calls; drizzle's D1 driver calls the rest. */
export interface D1Binding {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<unknown>
}

interface D1Statement {
  raw(): Promise<unknown[][]>
}

/** D1 binds at most this many parameters in one statement. */
const D1_MAX_BOUND_PARAMETERS = 100

export function d1(binding: D1Binding): DatabaseDriver {
  return {
    name: 'd1',
    maxBoundParameters: D1_MAX_BOUND_PARAMETERS,
    open: () => ({ db: drizzle(binding as Parameters<typeof drizzle>[0], { schema }), close: () => {} }),
  }
}

/**
 * Applies the migrations the database has not seen, one batch each: a batch is a transaction, so a
 * migration and its journal row land together, and D1 gives a batch 30 seconds, so one slow
 * migration cannot take the others past it. A failed one stops the run with the earlier ones kept,
 * and the next run starts at it. Same journal table and rule as drizzle's migrator, so a database
 * it migrated continues here: a migration is pending when it is newer than the newest journal row.
 *
 * A new database is the exception: all of its migrations go in one batch. Its tables are empty, so
 * the batch is far from the 30 seconds, and each batch is a request the caller waits for. A failed
 * batch leaves the database new, and the next run starts over.
 */
export async function migrateD1(binding: D1Binding, migrations: readonly MigrationMeta[]): Promise<void> {
  const table = `"${MIGRATIONS_TABLE.replaceAll('"', '""')}"`
  await binding.prepare(`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`).raw()
  const [last] = await binding.prepare(`SELECT created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`).raw()
  const lastMillis = last ? Number(last[0]) : -Infinity

  const pending = migrations.filter((migration) => migration.folderMillis > lastMillis)
  for (const migration of pending) {
    if (!/^[0-9a-f]+$/.test(migration.hash) || !Number.isInteger(migration.folderMillis)) {
      throw new Error(`Malformed migration journal entry ${migration.hash}`)
    }
  }
  const isNewDatabase = last === undefined
  const batches = isNewDatabase && pending.length > 0 ? [pending] : pending.map((migration) => [migration])
  for (const batch of batches) {
    const statements = batch.flatMap((migration) => [
      ...migration.sql.filter((statement) => statement.trim()),
      // Inlined, not bound: the batch runs plain statements.
      `INSERT INTO ${table} ("hash", "created_at") VALUES ('${migration.hash}', ${migration.folderMillis})`,
    ])
    await binding.batch(statements.map((statement) => binding.prepare(statement)))
  }
}
