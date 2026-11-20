import type { PGlite } from '@electric-sql/pglite'
import { type Database, txStorage } from './database'

/**
 * Database backed by PGlite (in-process WASM Postgres). Lets the full app run
 * locally against a real Postgres engine with no Docker — used by dev-server.ts
 * for honest local screenshots and by any test that wants a live backend rather
 * than FakeDatabase. Same `$1` params and SQL as PgDatabase, so repos behave
 * identically.
 */
export class PgliteDatabase implements Database {
  /**
   * Mutex chain: PGlite is one connection with connection-global transaction
   * state, so EVERYTHING through one instance serializes here — transactions
   * and lone queries alike. Otherwise an autocommit query landing mid-txn
   * either joins that transaction or, worse, trips over its aborted state
   * (25P02). Calls already inside this instance's transaction bypass via
   * txStorage, so joining cannot deadlock. (Dev/test only; production uses
   * real pooled connections without this constraint.)
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(private pg: PGlite) {}

  private async runQuery<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pg.query<T>(sql, params as unknown[])
    return res.rows
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = this.queue
    this.queue = previous.then(() => gate)
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (txStorage.getStore()?.pglite === this) return this.runQuery<T>(sql, params)
    return this.exclusive(() => this.runQuery<T>(sql, params))
  }

  async withTransaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const ambient = txStorage.getStore()
    if (ambient?.pglite === this) return fn(ambient.db) // nested: join the outer transaction
    return this.exclusive(async () => {
      await this.runQuery('BEGIN')
      try {
        const out = await txStorage.run({ pglite: this, db: this }, () => fn(this))
        await this.runQuery('COMMIT')
        return out
      } catch (err) {
        try {
          await this.runQuery('ROLLBACK')
        } catch {
          // Mirror PgDatabase: a dead connection has nothing left to roll back.
        }
        throw err
      }
    })
  }
}
