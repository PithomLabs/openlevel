/**
 * P2 staging setup (Phase 0, isolated). Operator-invoked, one-shot.
 *
 * Applies the staging proof schema + DBOS system migrations to the Neon
 * staging database. This is intentionally SEPARATE from phase0/setup-db.ts:
 * db-guard enforces the phase0_* namespace + loopback, which staging can
 * never satisfy. Staging safety comes from a different, explicit contract:
 *
 * - Both URLs must be postgres:// with sslmode=require (or stronger).
 * - Both hosts must be NON-loopback (staging is remote by definition;
 *   local databases belong to the local/CI paths, never here).
 * - Both URLs must name the SAME database (V2.1 §9: one database, app +
 *   dbos schemas), and the operator must repeat that exact name via
 *   --confirm-db. Anything else refuses without touching the server.
 * - Only additive DDL (IF NOT EXISTS); never drops, truncates, or deletes.
 * - Dangerous PG* redirect env must be unset.
 *
 * Usage:
 *   P2_SYSTEM_DATABASE_URL=... P2_APPLICATION_DATABASE_URL=... \
 *     node phase0/p2/setup-staging.mjs --confirm-db <exact-db-name> [--app-role <role>]
 *
 * With --app-role, DML on the app proof tables is granted to that role;
 * without it, the required GRANT statements are printed for the operator.
 * Exits 2 on any refusal (nothing applied), 0 with a table inventory.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';

const here = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_ENV = ['PGSERVICE', 'PGSERVICEFILE', 'PGPASSFILE', 'PGOPTIONS'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Split plain DDL on semicolons. Refuses dollar-quoted bodies (functions/triggers need a real parser). Pure. */
export function splitSqlStatements(sql) {
  if (sql.includes('$$')) {
    throw new Error('refusing to apply: schema contains dollar-quoted body (needs a real statement parser)');
  }
  const out = [];
  for (const chunk of sql.split(';')) {
    const stmt = chunk.replace(/--[^\n]*/g, '').trim();
    if (stmt.length > 0) out.push(stmt);
  }
  return out;
}

/** Validate one staging URL without connecting. Returns {host, db, sslmode}. Pure. */
export function parseStagingUrl(url, label) {
  if (!url) throw new Error(`refusing setup: ${label} is not set`);
  const scheme = url.split('://')[0]?.toLowerCase() ?? '';
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    throw new Error(`refusing setup: ${label} must use postgres:// or postgresql://`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing setup: ${label} is malformed`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host) || host === '') {
    throw new Error(`refusing setup: ${label} targets loopback or empty host (staging is remote; local belongs to local/CI paths)`);
  }
  const sslmode = (parsed.searchParams.get('sslmode') ?? '').toLowerCase();
  if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
    throw new Error(`refusing setup: ${label} must set sslmode=require (or verify-ca/verify-full)`);
  }
  const db = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
  if (!db) throw new Error(`refusing setup: ${label} names no database`);
  return { host, db, sslmode };
}

/** Validate a role name for SQL interpolation. Pure (throws). */
export function assertValidRoleName(appRole) {
  if (!ROLE_PATTERN.test(appRole)) throw new Error(`refusing setup: invalid role name "${appRole}"`);
}

/** Build the DML grants for the app proof + P3 wallet tables. Pure. */
export function stagingGrants(appRole) {
  assertValidRoleName(appRole);
  const q = `"${appRole}"`;
  return [
    `GRANT USAGE ON SCHEMA "app" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p2_probe_log" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p2_worker_generation" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p2_provider_ledger" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p3_operation" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p3_attempt" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p3_wallet" TO ${q}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "app"."p3_settlement" TO ${q}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "app" TO ${q}`,
  ];
}

/** CONNECT grant + idempotent NOLOGIN role creation (migrator runs these). Pure builders. */
export function connectGrant(appRole, dbName) {
  assertValidRoleName(appRole);
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`refusing setup: invalid database name "${dbName}"`);
  return `GRANT CONNECT ON DATABASE "${dbName}" TO "${appRole}"`;
}

export function createRoleStatement(appRole) {
  assertValidRoleName(appRole);
  // No IF NOT EXISTS for roles: the DO block makes creation idempotent.
  // NOLOGIN by design — a login role is granted membership separately, so
  // setup never mints or handles a password.
  return `DO $do$ BEGIN CREATE ROLE "${appRole}" WITH NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $do$`;
}

export function redactUrl(url) {
  return String(url).replace(/:\/\/([^:@/]+):[^@/]*@/, '://$1:<redacted>@');
}

async function main() {
  const args = process.argv.slice(2);
  const confirmIdx = args.indexOf('--confirm-db');
  const confirmDb = confirmIdx >= 0 ? args[confirmIdx + 1] : '';
  const roleIdx = args.indexOf('--app-role');
  const appRole = roleIdx >= 0 ? args[roleIdx + 1] : '';
  if (!confirmDb) {
    console.error('FATAL: refusing setup: pass --confirm-db <exact-database-name> naming the staging database');
    process.exit(2);
  }
  for (const name of FORBIDDEN_ENV) {
    if (process.env[name]) {
      console.error(`FATAL: refusing setup: ${name} is set and could redirect the session; unset it first`);
      process.exit(2);
    }
  }
  let sys, app;
  try {
    sys = parseStagingUrl(process.env.P2_SYSTEM_DATABASE_URL ?? '', 'P2_SYSTEM_DATABASE_URL');
    app = parseStagingUrl(process.env.P2_APPLICATION_DATABASE_URL ?? '', 'P2_APPLICATION_DATABASE_URL');
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
  if (sys.db !== app.db) {
    console.error(`FATAL: refusing setup: system (${sys.db}) and application (${app.db}) databases differ (V2.1: one database, app + dbos schemas)`);
    process.exit(2);
  }
  if (sys.db !== confirmDb) {
    console.error(`FATAL: refusing setup: --confirm-db "${confirmDb}" does not match the staging database "${sys.db}"`);
    process.exit(2);
  }

  const sysPool = new Pool({ connectionString: process.env.P2_SYSTEM_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  const appPool = new Pool({ connectionString: process.env.P2_APPLICATION_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const result = await applyStagingSetup({
      sysUrl: process.env.P2_SYSTEM_DATABASE_URL,
      appUrl: process.env.P2_APPLICATION_DATABASE_URL,
      dbName: sys.db,
      appRole: appRole || null,
      sysPool,
      appPool,
    });
    console.log(`system target: ${redactUrl(process.env.P2_SYSTEM_DATABASE_URL)} (${result.sysVersion})`);
    console.log(`application target: ${redactUrl(process.env.P2_APPLICATION_DATABASE_URL)} (${result.appVersion})`);
    console.log('dbos system schema: migrated');
    console.log('app proof schema: applied (additive only)');
    if (appRole) {
      console.log(`app proof grants: applied to role "${appRole}"`);
    } else {
      console.log('app proof grants: NOT applied (no --app-role); operator must run (with the real role):');
      for (const grant of stagingGrants('app_role_placeholder')) {
        console.log(`  ${grant.replaceAll('"app_role_placeholder"', '"<role>"')};`);
      }
      console.log(`  ${connectGrant('app_role_placeholder', sys.db).replaceAll('"app_role_placeholder"', '"<role>"')};`);
    }
    console.log(`app proof tables present: ${result.tables.join(', ')}`);
  } finally {
    await sysPool.end().catch(() => undefined);
    await appPool.end().catch(() => undefined);
  }
}

/**
 * Apply the full staging setup over caller-supplied pools. Exported so CI
 * verifies the real path (see verify-staging-apply.mjs); the CLI above
 * only validates and prints. Order: migrate dbos schema (with runtime
 * grants when a role is given) → p2 schema → p3 schema into app →
 * role + grants. Additive and idempotent throughout.
 */
export async function applyStagingSetup({ sysUrl, appUrl, dbName, appRole, sysPool, appPool }) {
  const ownSys = sysPool ?? new Pool({ connectionString: sysUrl, max: 1, connectionTimeoutMillis: 15000 });
  const ownApp = appPool ?? new Pool({ connectionString: appUrl, max: 1, connectionTimeoutMillis: 15000 });
  try {
    const sysVer = await ownSys.query('SHOW server_version');
    const appVer = await ownApp.query('SHOW server_version');
    await DBOS.migrate(sysUrl, appRole ? { schemaName: 'dbos', applicationRole: appRole } : { schemaName: 'dbos' });
    const p2Sql = readFileSync(join(here, 'schema.sql'), 'utf8');
    for (const stmt of splitSqlStatements(p2Sql)) {
      await ownApp.query(stmt);
    }
    // P3 wallet tables into app: applied as ONE multi-statement transaction
    // with an explicit search_path (never the naive splitter — the trigger
    // bodies contain dollar quotes, and never an ambient search_path).
    const p3Sql = readFileSync(join(here, '..', 'p3', 'schema.sql'), 'utf8');
    await ownApp.query(`BEGIN; SET LOCAL search_path = app; ${p3Sql} COMMIT;`);
    if (appRole) {
      await ownApp.query(createRoleStatement(appRole));
      await ownSys.query(connectGrant(appRole, dbName));
      for (const grant of stagingGrants(appRole)) {
        await ownApp.query(grant);
      }
    }
    const inv = await ownApp.query(
      `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'app' AND (tablename LIKE 'p2\\_%' ESCAPE '\\' OR tablename LIKE 'p3\\_%' ESCAPE '\\') ORDER BY 1`,
    );
    return {
      sysVersion: sysVer.rows[0].server_version,
      appVersion: appVer.rows[0].server_version,
      tables: inv.rows.map((r) => r.t),
    };
  } finally {
    if (!sysPool) await ownSys.end().catch(() => undefined);
    if (!appPool) await ownApp.end().catch(() => undefined);
  }
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main().catch((err) => {
    console.error(`FATAL: ${redactUrl(String((err && err.message) || err)).slice(0, 500)}`);
    process.exit(1);
  });
}
