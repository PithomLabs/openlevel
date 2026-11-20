import { AsyncLocalStorage } from 'node:async_hooks'
import type { Pool, PoolClient } from 'pg'

/**
 * Thin query surface every repo depends on. Keeping repos behind this interface
 * (rather than a raw pg Pool) is what makes the tenancy invariant unit-testable
 * with FakeDatabase — no live Postgres required to prove location isolation.
 */
export interface Database {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  /**
   * Run fn inside a transaction: commit on success, roll back on throw.
   * Nested calls join the caller's transaction (only the outermost commits
   * or rolls back) — no savepoints, no partial nesting. Concurrent calls on
   * the same pool get separate connections (true isolation); concurrent
   * calls on one single-connection instance serialize behind a mutex.
   */
  withTransaction<T>(fn: (db: Database) => Promise<T>): Promise<T>
}

/**
 * Ambient transaction context (async-local). Lets a nested withTransaction —
 * even one invoked on the pool-level handle rather than the tx handle — find
 * and join the enclosing transaction instead of opening a conflicting second
 * one. Scoped by resource identity (pool or PGlite instance), so unrelated
 * databases in one async chain never join each other.
 */
export interface TxStore {
  pool?: Pool
  pglite?: object
  db: Database
}

export const txStorage = new AsyncLocalStorage<TxStore>()

/** Production implementation backed by a pg connection pool. */
export class PgDatabase implements Database {
  constructor(
    private pool: Pool,
    private client?: PoolClient,
  ) {}
  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.client) {
      // A pool-level query issued inside one of this pool's transactions joins
      // it, so helpers holding the outer handle cannot silently escape the txn.
      const ambient = txStorage.getStore()
      if (ambient?.pool === this.pool) return ambient.db.query<T>(sql, params)
    }
    const result = await (this.client ?? this.pool).query(sql, params as unknown[])
    return result.rows as T[]
  }
  async withTransaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const ambient = txStorage.getStore()
    if (ambient?.pool === this.pool) return fn(ambient.db) // nested: join the outer transaction
    const client = await this.pool.connect()
    const tx = new PgDatabase(this.pool, client)
    try {
      await client.query('BEGIN')
      const out = await txStorage.run({ pool: this.pool, db: tx }, () => fn(tx))
      await client.query('COMMIT')
      return out
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // Rollback can only fail if the connection itself is dead, in which
        // case there is nothing left to roll back; the original error wins.
      }
      throw err
    } finally {
      client.release()
    }
  }
}
