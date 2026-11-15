/**
 * Phase 0 setup contracts (prompt24 Fix A).
 *
 * Pure, importable constants shared by `setup-db.ts` (runtime) and
 * `setup-contracts.test.ts` (regression). Extracted because `setup-db.ts`
 * executes `main()` against a live database on import, so its allowlist
 * cannot be unit-tested in place — and because the P2 `42P01` failure
 * proved the `public`-schema TRUNCATE allowlist must be tested by value
 * (it builds its SQL dynamically, so no source-substring check could
 * ever catch a stray entry).
 */

/**
 * Public-schema tables the scratch runtime (`phase0_rt`) may TRUNCATE for
 * test isolation. P1/P3 prototype tables ONLY.
 *
 * P2 proof tables live in `app` (V2.1 §9) and must never appear here:
 * granting against a nonexistent `public` relation fails setup with
 * `42P01`. Exact set — add nothing without a proven local consumer.
 */
export const PUBLIC_TRUNCATE_TABLES = [
  'p1_business_event',
  'p1_business_event_generation',
  'p1_business_event_discrepancy',
  'p1_domain_action',
  'p1_execution_log',
  'p3_operation',
  'p3_attempt',
  'p3_wallet',
  'p3_settlement',
] as const;

/**
 * Schemas scanned by the setup verification inventory. `public` holds the
 * local/CI P1/P3 prototype tables; `app` holds the P2 proof tables applied
 * from the staging schema file every run. `dbos` is retained from the
 * original query (it matches nothing prototype-named; kept so the only
 * behavior change is the added `app` coverage).
 */
export const PROTOTYPE_INVENTORY_SCHEMAS = ['public', 'app', 'dbos'] as const;
