/**
 * P2 recovery evidence checker (staging proof harness). Read-only: inspects
 * the provider ledger, attempt states, operation state, and probe marks,
 * then reports PASS/FAIL per assertion. It never dispatches, settles, or
 * refunds — quarantine is verified by inspection, and the P3 sweeper's
 * refusal logic is already proven by P3 unit/integration tests, so running
 * a refund-capable sweeper against staging adds mutation risk for no new
 * proof.
 *
 * Usage:
 *   node phase0/p2/check-recovery.mjs --op <operation-id> --tag <run-tag> [--expect-recovery 1]
 *
 * Env: P2_APPLICATION_DATABASE_URL (validated like setup-staging).
 * Exit 0 when every assertion passes, 1 otherwise, 2 on misuse.
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { parseFlagPairs, needFlag } from './argparse.mjs';
import { parseStagingUrl, redactUrl } from './setup-staging.mjs';

/** Parse argv into {op, tag, expectRecovery}. Pure (throws on misuse). */
export function parseArgs(argv) {
  const flags = parseFlagPairs(argv, ['op', 'tag', 'expect-recovery']);
  return { op: needFlag(flags, 'op'), tag: needFlag(flags, 'tag'), expectRecovery: flags['expect-recovery'] === '1' };
}

/**
 * Run the recovery assertions against any pool (real or stub). Returns one
 * verdict row per assertion; callers decide the exit code. Read-only.
 *
 * Deliberately NOT asserted: attempt COUNT. A kill before first provider
 * contact legitimately yields two attempts (stale first quarantined,
 * second genuinely dispatched with no prior acceptance) — one ACCEPTANCE
 * is the invariant, and attempt states must all be resolved.
 */
export async function runRecoveryChecks(pool, { op, tag, expectRecovery }) {
  const verdicts = [];
  const push = (name, pass, detail) => verdicts.push({ name, pass, detail });
  const attempts = (
    await pool.query(`SELECT attempt_id, state FROM p3_attempt WHERE operation_id = $1 ORDER BY attempt_id`, [op])
  ).rows;
  const ledger = (
    await pool.query(`SELECT attempt_id FROM app.p2_provider_ledger WHERE operation_id = $1`, [op])
  ).rows;
  const ops = (await pool.query(`SELECT billing_state FROM p3_operation WHERE operation_id = $1`, [op])).rows;

  push('exactly-one-acceptance', ledger.length === 1, `${ledger.length} ledger row(s) for ${op}`);
  const attemptIds = new Set(attempts.map((a) => a.attempt_id));
  push(
    'dispatch-integrity',
    ledger.every((l) => attemptIds.has(l.attempt_id)),
    `every acceptance joins a real attempt (${ledger.length} ledger, ${attempts.length} attempts)`,
  );
  const bad = attempts.filter((a) => a.state !== 'succeeded' && a.state !== 'uncertain');
  push(
    'no-unresolved-dispatching',
    bad.length === 0,
    bad.length === 0
      ? `all ${attempts.length} attempt(s) resolved`
      : `unresolved: ${bad.map((a) => `${a.attempt_id}:${a.state}`).join(', ')}`,
  );
  const billing = ops.length > 0 ? ops[0].billing_state : '(missing)';
  push('operation-not-blindly-refunded', billing !== 'refunded', `billing_state=${billing}`);
  if (expectRecovery) {
    const marks = (
      await pool.query(`SELECT mark, count(*)::int AS n FROM app.p2_probe_log WHERE workflow_id LIKE $1 GROUP BY 1`, [
        `${tag}%`,
      ])
    ).rows;
    const markSet = new Set(marks.map((m) => m.mark));
    push(
      'recovery-marks-present',
      markSet.has('redispatch-refused') && markSet.has('acceptance-count-1'),
      [...markSet].join(', ') || '(no marks)',
    );
  }

  // NOTE: search_path=app is a connection concern, not a query concern:
  // staging pools set it (probe pool options), so unqualified p3_* names
  // resolve to app.* here. The app.* names above are explicit regardless.
  return verdicts;
}

async function main() {
  let spec;
  try {
    spec = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
  try {
    parseStagingUrl(process.env.P2_APPLICATION_DATABASE_URL ?? '', 'P2_APPLICATION_DATABASE_URL');
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
  const pool = new Pool({
    connectionString: process.env.P2_APPLICATION_DATABASE_URL,
    max: 1,
    options: '-c search_path=app',
  });
  try {
    const verdicts = await runRecoveryChecks(pool, spec);
    let failed = 0;
    for (const v of verdicts) {
      console.log(`${v.pass ? 'RECOVERY-OK  ' : 'RECOVERY-FAIL'} ${v.name} — ${v.detail}`);
      if (!v.pass) failed += 1;
    }
    if (failed > 0) {
      console.log(`recovery: FAIL (${failed}/${verdicts.length} assertions failed)`);
      process.exit(1);
    }
    console.log('recovery: PASS');
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main().catch((err) => {
    console.error(`FATAL: ${redactUrl(String((err && err.message) || err)).slice(0, 500)}`);
    process.exit(1);
  });
}
