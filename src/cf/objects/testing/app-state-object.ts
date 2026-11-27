/**
 * The org's AppState object for tests: the real class over an in-memory SQLite database, reached
 * the way a stub reaches it, so a test can run code against the Cloudflare AppState.
 */
import Database from 'better-sqlite3'
import type { DurableObjectNamespace, DurableObjectState, SqlStorage, SqlStorageValue } from 'cloudflare:workers'
import { AppStateDurableObject, type EventHub } from '../cloudflare-app-state'
import type { Env } from '../../index'

/** A Durable Object's `ctx.storage.sql` over an in-memory SQLite database. */
export function memorySql(): SqlStorage {
  const db = new Database(':memory:')
  return {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      const statement = db.prepare(query)
      let rows: unknown[] = []
      if (statement.reader) rows = statement.all(...bindings)
      else statement.run(...bindings)
      return { toArray: () => rows, one: () => rows[0] }
    },
  } as SqlStorage
}

/** An AppStateDurableObject whose clock the test moves. */
export class TestObject extends AppStateDurableObject {
  clock = Date.UTC(2026, 10, 5)

  protected override now(): number {
    return this.clock
  }
}

export function testObject(sql: SqlStorage = memorySql(), sockets: unknown[] = []): TestObject {
  const ctx = { id: { name: 'org', toString: () => 'org' }, storage: { sql, transactionSync: <T>(decide: () => T) => decide() }, getWebSockets: () => sockets, acceptWebSocket: () => {} }
  return new TestObject(ctx as unknown as DurableObjectState, {} as Env)
}

/** The object's methods as its stub calls them: later, on copies of the arguments and the answers. */
export function namespaceOf(object: AppStateDurableObject): DurableObjectNamespace<AppStateDurableObject> {
  const stub = new Proxy({}, {
    get: (_target, name) => (...args: unknown[]) => Promise.resolve().then(() => {
      const method = Reflect.get(object, name) as (...methodArgs: unknown[]) => unknown
      return structuredClone(method.apply(object, structuredClone(args)))
    }),
  })
  return { getByName: () => stub } as unknown as DurableObjectNamespace<AppStateDurableObject>
}

/** The object's fan-out in memory: each publish reaches every connection subscribed to its channel. */
export function memoryHub(): EventHub {
  const connections = new Set<{ channels: Set<string>; onEvent: (channel: string, json: string) => void }>()
  return {
    async publish(fullChannel, json) {
      for (const connection of [...connections]) if (connection.channels.has(fullChannel)) connection.onEvent(fullChannel, json)
    },
    async connect(fullChannels, onEvent) {
      const connection = { channels: new Set(fullChannels), onEvent }
      connections.add(connection)
      return { close: () => connections.delete(connection) }
    },
  }
}
