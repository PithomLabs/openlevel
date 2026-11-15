/**
 * setup-contracts tests (no database). Pin the local/CI vs staging schema
 * contract that the `integration` 42P01 failure broke: the public-schema
 * TRUNCATE allowlist must hold exactly the P1/P3 prototype tables (P2
 * proof tables live in `app` per V2.1 §9), and the setup inventory must
 * scan `app` so the report matches the real layout.
 *
 * These assert on the extracted VALUES. The defective code built its GRANT
 * dynamically from an inline array, so no source-substring check could
 * ever catch the stray `p2_probe_log` entry — this test fails against the
 * original allowlist content and passes only with it removed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PROTOTYPE_INVENTORY_SCHEMAS, PUBLIC_TRUNCATE_TABLES } from './setup-contracts.js';

describe('public TRUNCATE allowlist (local/CI contract)', () => {
  test('excludes every P2 staging table (P2 lives in app, never public)', () => {
    expect(PUBLIC_TRUNCATE_TABLES).not.toContain('p2_probe_log');
    for (const t of PUBLIC_TRUNCATE_TABLES) {
      expect(t.startsWith('p2_')).toBe(false);
    }
  });

  test('is exactly the P1/P3 prototype tables (any stray entry fails)', () => {
    expect([...PUBLIC_TRUNCATE_TABLES].sort()).toEqual(
      [
        'p1_business_event',
        'p1_business_event_discrepancy',
        'p1_business_event_generation',
        'p1_domain_action',
        'p1_execution_log',
        'p3_attempt',
        'p3_operation',
        'p3_settlement',
        'p3_wallet',
      ].sort(),
    );
  });
});

describe('prototype inventory schemas', () => {
  test('includes app so the setup report matches the real layout', () => {
    expect(PROTOTYPE_INVENTORY_SCHEMAS).toContain('public');
    expect(PROTOTYPE_INVENTORY_SCHEMAS).toContain('app');
  });
});

describe('setup-db.ts wiring (no shadow list)', () => {
  test('setup consumes the extracted contracts and names no P2 table', () => {
    const src = readFileSync('phase0/setup-db.ts', 'utf8');
    expect(src).toContain("from './setup-contracts.js'");
    expect(src).toContain('PUBLIC_TRUNCATE_TABLES');
    expect(src).toContain('PROTOTYPE_INVENTORY_SCHEMAS');
    expect(src).not.toContain('p2_probe_log');
  });
});
