/**
 * staging-provider tests (no database). A stub pool stands in for pg.Pool:
 * ledger writes, redispatch refusal, and acceptance counting are asserted
 * on the recorded statements. Live Neon behavior stays staging-only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Pool } from 'pg';
import {
  assertNoPriorAcceptance,
  countAcceptances,
  createLedgerProvider,
  redispatchAllowed,
} from './staging-provider.js';

interface RecordedQuery {
  text: string;
  params: unknown[];
}

function stubPool(rowsForSelect: Array<Record<string, unknown>> = []): { pool: Pool; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (/^\s*SELECT/i.test(text)) return { rows: rowsForSelect };
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as Pool, queries };
}

describe('redispatchAllowed', () => {
  test('no acceptance allows dispatch; any same-op acceptance refuses', () => {
    expect(redispatchAllowed([], 'op-1')).toBe(true);
    expect(redispatchAllowed([{ operation_id: 'op-2', attempt_id: 'a9' }], 'op-1')).toBe(true);
    expect(redispatchAllowed([{ operation_id: 'op-1', attempt_id: 'a1' }], 'op-1')).toBe(false);
  });
});

describe('assertNoPriorAcceptance', () => {
  test('passes silently with zero acceptances', async () => {
    const { pool, queries } = stubPool([]);
    await assertNoPriorAcceptance(pool, 'op-1');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text ?? '').toContain('app.p2_provider_ledger');
    expect(queries[0]?.params).toEqual(['op-1']);
  });

  test('throws ConflictError naming the operation and attempt', async () => {
    const { pool } = stubPool([{ attempt_id: 'a1' }, { attempt_id: 'a2' }]);
    await expect(assertNoPriorAcceptance(pool, 'op-1')).rejects.toThrow(/refusing redispatch/);
    await expect(assertNoPriorAcceptance(pool, 'op-1')).rejects.toThrow(/op-1/);
    await expect(assertNoPriorAcceptance(pool, 'op-1')).rejects.toThrow(/a1/);
  });
});

describe('countAcceptances', () => {
  test('returns the ledger count for exactly-one assertions', async () => {
    const { pool } = stubPool([{ n: 1 }]);
    await expect(countAcceptances(pool, 'op-1')).resolves.toBe(1);
  });
});

describe('createLedgerProvider', () => {
  test('accepts with a single autocommitted ledger INSERT (own transaction)', async () => {
    const { pool, queries } = stubPool([]);
    const provider = createLedgerProvider(pool);
    const result = await provider({
      attemptId: 'a1',
      operationId: 'op-1',
      inputTokens: 10,
      outputTokens: 20,
      mode: 'ok',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text ?? '').toContain('INSERT INTO app.p2_provider_ledger');
    expect(queries[0]?.params).toEqual(['op-1', 'a1']);
    expect(queries[0]?.text ?? '').not.toMatch(/BEGIN|COMMIT/i);
    expect(result).toEqual({ attemptId: 'a1', requestId: 'p2-ledger-a1', inputTokens: 10, outputTokens: 20 });
  });

  test('optional hold keeps the response open after the ledger commit', async () => {
    const { pool, queries } = stubPool([]);
    const provider = createLedgerProvider(pool, { holdAfterAcceptMs: 50 });
    const t0 = Date.now();
    await provider({ attemptId: 'a1', operationId: 'op-1', inputTokens: 1, outputTokens: 1, mode: 'ok' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    expect(queries).toHaveLength(1); // hold issues no further statements
  });

  test('timeout-after-accept commits the ledger then throws ProviderTimeoutError', async () => {
    const { pool, queries } = stubPool([]);
    const provider = createLedgerProvider(pool, { timeoutAfterAccept: true });
    await expect(
      provider({ attemptId: 'a1', operationId: 'op-1', inputTokens: 1, outputTokens: 1, mode: 'ok' }),
    ).rejects.toThrow(/uncertain outcome for a1/);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text ?? '').toContain('INSERT INTO app.p2_provider_ledger');
  });

  test('unique-violation loser becomes an explicit contention error (never a second acceptance)', async () => {
    const pool = {
      query: async () => {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      },
    } as unknown as Pool;
    const provider = createLedgerProvider(pool);
    await expect(
      provider({ attemptId: 'a2', operationId: 'op-1', inputTokens: 1, outputTokens: 1, mode: 'ok' }),
    ).rejects.toThrow(/already accepted operation op-1.*contending attempt a2 loses/);
  });

  test('non-constraint provider errors propagate untouched (not mislabeled contention)', async () => {
    const pool = {
      query: async () => {
        throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
      },
    } as unknown as Pool;
    const provider = createLedgerProvider(pool);
    await expect(
      provider({ attemptId: 'a2', operationId: 'op-1', inputTokens: 1, outputTokens: 1, mode: 'ok' }),
    ).rejects.toThrow(/connection reset/);
  });

  test('ledger constraint is exactly UNIQUE(operation_id) (M4 invariant pin)', () => {
    const sql = readFileSync('phase0/p2/schema.sql', 'utf8');
    expect(sql).toContain('UNIQUE (operation_id)');
    expect(sql).not.toContain('UNIQUE (operation_id, attempt_id)');
  });
});
