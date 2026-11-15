/**
 * T2 in-flight precondition gate (M5). Verifies the replacement is about
 * to interrupt genuinely active workflows — a deployment that starts
 * after everything completed must abort as NOT EXERCISED, never pass.
 *
 * Usage:
 *   node phase0/p2/check-inflight.mjs --tag <run-tag>
 * Env: P2_SYSTEM_DATABASE_URL (workflow statuses), P2_APPLICATION_DATABASE_URL
 * Exit: 0 exercised; 3 NOT EXERCISED (distinct code); 2 misuse/env; 1 infra error.
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { parseFlagPairs, needFlag } from './argparse.mjs';
import { parseStagingUrl, redactUrl } from './setup-staging.mjs';

/** Active (non-terminal, provable) DBOS workflow statuses. Anything else fails closed. */
export const ACTIVE_STATUSES = ['ENQUEUED', 'PENDING', 'RUNNING'];

/** Parse argv into {tag}. Pure (throws on misuse). */
export function parseArgs(argv) {
  const flags = parseFlagPairs(argv, ['tag']);
  return { tag: needFlag(flags, 'tag') };
}

/**
 * Evaluate fetched evidence. Pure. `marks` are probe_log marks for the tag;
 * `provider`/`uncertain` carry attempt rows + ledger count; statuses are
 * DBOS workflow statuses (null when unknown). Returns reasons; empty
 * reasons means exercised.
 */
export function evaluateInflight(evidence) {
  const reasons = [];
  const { marks, providerOp, uncertainOp, normalStatus, providerStatus } = evidence;
  const has = (m) => marks.includes(m);
  // Normal workflow: past step-1, not yet at step-2, verifiably active.
  if (!has('step-1')) reasons.push('normal workflow has no step-1 mark (not started?)');
  if (has('step-2')) reasons.push('normal workflow already completed step-2 (completed before replacement)');
  if (!ACTIVE_STATUSES.includes(normalStatus)) {
    reasons.push(`normal workflow status ${JSON.stringify(normalStatus)} is not provably active`);
  }
  // Provider workflow: dispatching attempt + independent acceptance exist,
  // post-call completion absent, workflow verifiably active.
  if (!providerOp.attempts.some((a) => a.state === 'dispatching')) {
    reasons.push('no dispatching provider attempt (nothing in flight)');
  }
  if (providerOp.ledgerCount < 1) reasons.push('no provider ledger acceptance (pre-dispatch window)');
  if (marks.some((m) => m.startsWith('post-call:'))) {
    reasons.push('provider post-call mark present (completed before replacement)');
  }
  if (!ACTIVE_STATUSES.includes(providerStatus)) {
    reasons.push(`provider workflow status ${JSON.stringify(providerStatus)} is not provably active`);
  }
  // Uncertain case: a quarantined attempt must already persist.
  if (!uncertainOp.attempts.some((a) => a.state === 'uncertain')) {
    reasons.push('no persisted uncertain attempt (T2 case 3 not staged)');
  }
  return reasons;
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
    parseStagingUrl(process.env.P2_SYSTEM_DATABASE_URL ?? '', 'P2_SYSTEM_DATABASE_URL');
    parseStagingUrl(process.env.P2_APPLICATION_DATABASE_URL ?? '', 'P2_APPLICATION_DATABASE_URL');
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
  const appPool = new Pool({
    connectionString: process.env.P2_APPLICATION_DATABASE_URL,
    max: 1,
    options: '-c search_path=app',
  });
  const client = await DBOSClient.create({
    systemDatabaseUrl: process.env.P2_SYSTEM_DATABASE_URL,
    systemDatabasePoolSize: 2,
  });
  try {
    const marks = (
      await appPool.query(`SELECT DISTINCT mark FROM app.p2_probe_log WHERE workflow_id LIKE $1`, [`${spec.tag}%`])
    ).rows.map((r) => r.mark);
    const opRows = async (purpose) =>
      (await appPool.query(`SELECT operation_id FROM p3_operation WHERE purpose = $1`, [purpose])).rows;
    const providerOps = await opRows(`p2-probe:${spec.tag}`);
    const uncertainOps = await opRows(`p2-probe:${spec.tag}-uncertain`);
    const attemptsFor = async (opId) =>
      (await appPool.query(`SELECT attempt_id, state FROM p3_attempt WHERE operation_id = $1`, [opId])).rows;
    const ledgerFor = async (opId) =>
      Number((await appPool.query(`SELECT count(*)::int AS n FROM app.p2_provider_ledger WHERE operation_id = $1`, [opId])).rows[0].n);
    const statusOf = async (workflowId) => {
      try {
        const st = await client.retrieveWorkflow(workflowId).getStatus();
        return st?.status ?? null;
      } catch {
        return null;
      }
    };
    const reasons = [];
    if (providerOps.length !== 1) {
      reasons.push(`expected exactly 1 provider operation for tag, found ${providerOps.length}`);
    }
    if (uncertainOps.length !== 1) {
      reasons.push(`expected exactly 1 uncertain operation for tag, found ${uncertainOps.length}`);
    }
    if (reasons.length === 0) {
      const providerOpId = providerOps[0].operation_id;
      const uncertainOpId = uncertainOps[0].operation_id;
      reasons.push(
        ...evaluateInflight({
          marks,
          providerOp: { attempts: await attemptsFor(providerOpId), ledgerCount: await ledgerFor(providerOpId) },
          uncertainOp: { attempts: await attemptsFor(uncertainOpId) },
          normalStatus: await statusOf(`p2-${spec.tag}-normal`),
          providerStatus: await statusOf(`p2-${spec.tag}-provider`),
        }),
      );
    }
    if (reasons.length > 0) {
      console.log('INFLIGHT-FAIL in-flight precondition not met — NOT EXERCISED, aborting replacement:');
      for (const r of reasons) console.log(`  - ${r}`);
      process.exit(3);
    }
    console.log('INFLIGHT-OK all workflows genuinely in flight; replacement may proceed');
  } finally {
    await client.destroy().catch(() => undefined);
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
