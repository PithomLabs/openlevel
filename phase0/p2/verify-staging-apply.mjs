/**
 * Staging-setup live verification (CI only — needs a real PostgreSQL).
 * Runs the REAL applyStagingSetup path twice against service postgres and
 * asserts: P2+P3 tables land in `app`, trigger/function survive, grants
 * are effective for the worker role (proven by acting AS the role, not by
 * reading catalogs alone), and re-application preserves a sentinel row.
 *
 * Usage (CI p2-boot-proof job, after the boot step):
 *   node phase0/p2/verify-staging-apply.mjs --role p2ci_worker
 * Env: P2_SYSTEM_DATABASE_URL, P2_APPLICATION_DATABASE_URL.
 * Exit 0 on PASS, 1 with diagnostics on any failure.
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { applyStagingSetup, assertValidRoleName, redactUrl } from './setup-staging.mjs';

function check(name, cond, detail) {
  console.log(`${cond ? 'SETUP-OK  ' : 'SETUP-FAIL'} ${name} — ${detail}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const args = process.argv.slice(2);
  const roleIdx = args.indexOf('--role');
  const role = roleIdx >= 0 ? args[roleIdx + 1] : '';
  if (!role) {
    console.error('FATAL: pass --role <test-worker-role>');
    process.exit(2);
  }
  try {
    assertValidRoleName(role);
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
  const sysUrl = process.env.P2_SYSTEM_DATABASE_URL ?? '';
  const appUrl = process.env.P2_APPLICATION_DATABASE_URL ?? '';
  if (!sysUrl || !appUrl) {
    console.error('FATAL: P2_SYSTEM_DATABASE_URL and P2_APPLICATION_DATABASE_URL are required');
    process.exit(2);
  }
  const sysPool = new Pool({ connectionString: sysUrl, max: 1 });
  const appPool = new Pool({ connectionString: appUrl, max: 1 });
  try {
    const dbName = new URL(appUrl).pathname.replace(/^\//, '');
    const first = await applyStagingSetup({ sysUrl, appUrl, dbName, appRole: role, sysPool, appPool });
    const expected = [
      'p2_probe_log',
      'p2_provider_ledger',
      'p2_worker_generation',
      'p3_attempt',
      'p3_operation',
      'p3_settlement',
      'p3_wallet',
    ];
    check(
      'p2+p3-tables-in-app',
      expected.every((t) => first.tables.includes(t)),
      first.tables.join(','),
    );
    const func = await appPool.query(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'app' AND p.proname = 'p3_archive_attempts'`,
    );
    const trig = await appPool.query(
      `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'app' AND t.tgname = 'p3_attempt_archive_on_truncate'`,
    );
    check('p3-function-survives', func.rows[0].n === 1, `p3_archive_attempts count=${func.rows[0].n}`);
    check('p3-trigger-survives', trig.rows[0].n === 1, `p3_attempt_archive_on_truncate count=${trig.rows[0].n}`);
    // Effective privilege proof: act AS the worker role (the grantor can
    // SET ROLE to it) and perform real DML, then roll back without residue
    // and reset the role explicitly (plain SET survives ROLLBACK).
    const acted = await appPool.query(
      `BEGIN;
       SET ROLE "${role}";
       INSERT INTO app.p2_probe_log (workflow_id, mark) VALUES ('ci-verify', 'role-probe');
       SELECT has_table_privilege('app.p3_attempt', 'INSERT') AS p3ins,
              has_table_privilege('app.p2_provider_ledger', 'SELECT') AS p2sel;
       ROLLBACK;
       RESET ROLE;`,
    );
    const privs = acted[3].rows[0];
    check('worker-role-effective-dml', privs.p3ins === true && privs.p2sel === true, JSON.stringify(privs));
    const stillThere = await appPool.query(`SELECT count(*)::int AS n FROM app.p2_probe_log WHERE workflow_id = 'ci-verify'`);
    check('role-probe-rolled-back', stillThere.rows[0].n === 0, `residue rows=${stillThere.rows[0].n}`);
    // Idempotent re-application preserves existing state.
    await appPool.query(`INSERT INTO app.p2_probe_log (workflow_id, mark) VALUES ('ci-sentinel', 'sentinel')`);
    const second = await applyStagingSetup({ sysUrl, appUrl, dbName, appRole: role, sysPool, appPool });
    const sentinel = await appPool.query(`SELECT count(*)::int AS n FROM app.p2_probe_log WHERE workflow_id = 'ci-sentinel'`);
    check('reapply-preserves-state', sentinel.rows[0].n === 1, `sentinel rows=${sentinel.rows[0].n}`);
    check(
      'reapply-stable-inventory',
      JSON.stringify(second.tables) === JSON.stringify(first.tables),
      second.tables.join(','),
    );
    if (process.exitCode) console.log('staging-apply verification: FAIL');
    else console.log('staging-apply verification: PASS');
  } finally {
    await sysPool.end().catch(() => undefined);
    await appPool.end().catch(() => undefined);
  }
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main().catch((err) => {
    console.error(`FATAL: ${redactUrl(String((err && err.message) || err)).slice(0, 500)}`);
    process.exit(1);
  });
}
