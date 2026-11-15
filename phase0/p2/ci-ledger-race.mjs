/**
 * Ledger uniqueness race proof (M4, CI only — needs real PostgreSQL).
 * Proves UNIQUE(operation_id) arbitrates concurrent acceptances: session A
 * holds an uncommitted acceptance while session B attempts the same
 * operation, B is OBSERVED waiting (pg_stat_activity, bounded deadline —
 * never a fixed sleep), A commits, and B must then fail with 23505 while
 * exactly one ledger row survives. Also proves sequential double-accept
 * rejection at the constraint level.
 *
 * Usage (CI p2-boot-proof job, after staging-apply verification):
 *   node phase0/p2/ci-ledger-race.mjs
 * Env: P2_APPLICATION_DATABASE_URL. Exit 0 on PASS, 1 with diagnostics.
 */
import { Pool } from 'pg';

function check(name, cond, detail) {
  console.log(`${cond ? 'RACE-OK  ' : 'RACE-FAIL'} ${name} — ${detail}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  const url = process.env.P2_APPLICATION_DATABASE_URL ?? '';
  if (!url) {
    console.error('FATAL: P2_APPLICATION_DATABASE_URL is required');
    process.exit(2);
  }
  const poolA = new Pool({ connectionString: url, max: 1, application_name: 'ci-race-a' });
  const poolB = new Pool({ connectionString: url, max: 1, application_name: 'ci-race-b' });
  const observer = new Pool({ connectionString: url, max: 1, application_name: 'ci-race-observer' });
  const op = `ci-race-${Date.now()}`;
  try {
    const a = await poolA.connect();
    try {
      await a.query('BEGIN');
      await a.query(`INSERT INTO app.p2_provider_ledger (operation_id, attempt_id) VALUES ($1, $2)`, [op, 'a-A']);
      const b = await poolB.connect();
      try {
        await b.query('BEGIN');
        // B attempts the same operation: must block on A's uncommitted row.
        const bAttempt = b.query(`INSERT INTO app.p2_provider_ledger (operation_id, attempt_id) VALUES ($1, $2)`, [
          op,
          'a-B',
        ]);
        let bWaiting = false;
        const deadline = Date.now() + 30000;
        let snapshot = '(none)';
        while (Date.now() < deadline) {
          const r = await observer.query(
            `SELECT state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
             WHERE datname = current_database() AND application_name = 'ci-race-b'`,
          );
          snapshot = JSON.stringify(r.rows[0] ?? null);
          const row = r.rows[0];
          if (row && (row.wait_event_type === 'Lock' || (row.blockers ?? []).length > 0)) {
            bWaiting = true;
            break;
          }
          await new Promise((res) => setTimeout(res, 100));
        }
        check('contender-blocks-on-uncommitted-acceptance', bWaiting, snapshot);
        if (!bWaiting) {
          await b.query('ROLLBACK').catch(() => undefined);
          await a.query('ROLLBACK').catch(() => undefined);
          return;
        }
        await a.query('COMMIT');
        let bError = null;
        try {
          await bAttempt;
        } catch (err) {
          bError = err;
        }
        check('loser-gets-unique-violation', bError !== null && bError.code === '23505', bError ? `code=${bError.code}` : 'no error (BAD)');
        await b.query('ROLLBACK').catch(() => undefined);
      } finally {
        b.release();
      }
    } finally {
      a.release();
    }
    const rows = await observer.query(`SELECT attempt_id FROM app.p2_provider_ledger WHERE operation_id = $1`, [op]);
    check(
      'exactly-one-acceptance-after-race',
      rows.rows.length === 1 && rows.rows[0].attempt_id === 'a-A',
      JSON.stringify(rows.rows),
    );
    // Sequential double-accept (same op, different attempt) must also fail.
    let seqError = null;
    try {
      await observer.query(`INSERT INTO app.p2_provider_ledger (operation_id, attempt_id) VALUES ($1, $2)`, [op, 'a-C']);
    } catch (err) {
      seqError = err;
    }
    check('sequential-double-accept-rejected', seqError !== null && seqError.code === '23505', seqError ? `code=${seqError.code}` : 'no error (BAD)');
    await observer.query(`DELETE FROM app.p2_provider_ledger WHERE operation_id = $1`);
    if (process.exitCode) console.log('ledger race: FAIL');
    else console.log('ledger race: PASS (constraint arbitrated, exactly one acceptance)');
  } finally {
    await poolA.end().catch(() => undefined);
    await poolB.end().catch(() => undefined);
    await observer.end().catch(() => undefined);
  }
}

await main().catch((err) => {
  console.error(`FATAL: ${String((err && err.message) || err).slice(0, 500)}`);
  process.exit(1);
});
