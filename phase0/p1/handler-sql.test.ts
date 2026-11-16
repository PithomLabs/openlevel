/**
 * Static contract for the P1 duplicate-gate INSERT (prompt34 regression pin).
 * Pure text assertions — no database required. The live race proof stays in
 * p1.test.ts; this file pins the mechanism so the fix cannot regress silently.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const handler = readFileSync('phase0/p1/handler.ts', 'utf8');
const schema = readFileSync('phase0/p1/schema.sql', 'utf8');

describe('P1 duplicate-gate upsert contract', () => {
  test('business_event insert uses arbiterless ON CONFLICT DO NOTHING', () => {
    // The table carries TWO unique constraints (business_key PK plus the
    // workflow_id UNIQUE). A column arbiter tames only one: CI run 43824411092
    // proved losers then die on p1_business_event_workflow_id_key (23505).
    // Bare DO NOTHING handles conflicts on all usable constraints, and it is
    // safe here because workflow_id is a deterministic function of
    // business_key — every conflict is same-key by construction.
    const insert = handler.match(/INSERT INTO p1_business_event[\s\S]*?RETURNING/)?.[0] ?? '';
    expect(insert).toContain('ON CONFLICT DO NOTHING');
    expect(insert).not.toMatch(/ON CONFLICT\s*\(/);
  });

  test('workflow_id stays UNIQUE (never drop the constraint to pass)', () => {
    expect(schema).toMatch(/workflow_id\s+text NOT NULL UNIQUE/);
  });

  test('duplicate path still re-reads the winner by business key', () => {
    expect(handler).toContain('FROM p1_business_event WHERE business_key = $1 FOR UPDATE');
  });
});
