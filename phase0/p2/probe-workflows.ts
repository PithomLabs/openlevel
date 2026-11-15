/**
 * P2 staging probe worker (Phase 0, isolated infrastructure proof — NOT the
 * OpenLevel product application, which still runs pg-boss and has no DBOS
 * worker yet). Deployed ONLY to the staging worker. Proves Fly/DBOS
 * deployment, fencing, and recovery mechanics; MUST NOT be represented as
 * product DBOS-integration or production-readiness proof.
 *
 * Workflows (enqueued by phase0/p2/enqueue-probes.mjs onto queue 'p2'):
 * - p2-normal: durable steps; restart must not re-execute completed steps.
 * - p2-provider: P3 reserve → ledger-backed dispatch → settle, with a
 *   ledger pre-check inside the dispatch step so DBOS replay after a
 *   kill can never produce a second provider acceptance.
 * - p2-uncertain: dispatch whose provider response is lost → attempt stays
 *   uncertain (quarantined, never auto-retried).
 * - p2-recover: post-restart recovery proof — quarantine stale attempts,
 *   then PROVE redispatch refusal fires against the ledger evidence.
 *
 * API verified against installed @dbos-inc/dbos-sdk@5.5.0 .d.ts
 * (registerWorkflow/registerStep/registerQueue, setConfig/launch,
 * DBOSClient.create/enqueue). Queue registration stays AFTER launch per
 * the official DBOS queue tutorial; queue assignment happens at ENQUEUE
 * (queueName), not at registration.
 */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import {
  ConflictError,
  createOperation,
  dispatchAttempt,
  recoverStaleAttempts,
  reserve,
  settle,
} from '../p3/wallet.js';
import {
  assertNoPriorAcceptance,
  countAcceptances,
  createLedgerProvider,
} from './staging-provider.js';
import {
  P2_APP_NAME,
  P2_HEARTBEAT_INTERVAL_MS,
  P2_QUEUE,
  P2_STAGING_AGENCY,
  PROVIDER_HOLD_ENV_VAR,
  normalHoldMs,
  probeAppPoolOptions,
  probeHoldMs,
  stagingCaps,
} from './probe-config.js';

const sysUrl = process.env.P2_SYSTEM_DATABASE_URL ?? '';
const appUrl = process.env.P2_APPLICATION_DATABASE_URL ?? '';
if (!sysUrl) throw new Error('P2_SYSTEM_DATABASE_URL is required (DBOS system database)');
if (!appUrl) throw new Error('P2_APPLICATION_DATABASE_URL is required (probe data)');
// NOTE: no db-guard here by design — db-guard enforces the phase0_*
// namespace + loopback for local/CI proofs, which staging can never
// satisfy. Staging URL validation lives in boot-worker.mjs (scheme +
// presence + live preflight) and setup-staging.mjs (TLS + remote-only +
// operator confirmation). Proof tables are app-qualified per V2.1 §9;
// P3 wallet tables resolve via search_path=app (probe pool options).
const pool = new Pool(probeAppPoolOptions(appUrl, 'p2-probe-worker'));
const sysPool = new Pool({ connectionString: sysUrl, max: 1, application_name: 'p2-probe-sysdb' });

const markStep = DBOS.registerStep(
  async (workflowId: string, mark: string): Promise<string> => {
    // Plain INSERT deliberately (no ON CONFLICT swallowing): T2 kills only
    // AFTER workflows complete, so a duplicate mark proves a completed
    // step was really re-executed. In-flight replays (T3) are expected to
    // re-run incomplete steps — T3 therefore asserts ledger/attempt
    // identity, never step-mark counts.
    await pool.query(`INSERT INTO app.p2_probe_log (workflow_id, mark) VALUES ($1, $2)`, [workflowId, mark]);
    return mark;
  },
  { name: 'p2-mark' },
);

/** Seed staging test funds (idempotent) + create + reserve one operation. */
const opSetupStep = DBOS.registerStep(
  async (tag: string): Promise<{ operationId: string }> => {
    await pool.query(
      `INSERT INTO p3_wallet (agency_id, balance_credits_micro) VALUES ($1, $2)
       ON CONFLICT (agency_id) DO NOTHING`,
      [P2_STAGING_AGENCY, 1000000000000],
    );
    const operationId = await createOperation(pool, {
      agencyId: P2_STAGING_AGENCY,
      locationId: 'p2-staging',
      purpose: `p2-probe:${tag}`,
      provider: 'p2-ledger',
      caps: stagingCaps(),
    });
    await reserve(pool, operationId, 1000000);
    return { operationId };
  },
  { name: 'p2-op-setup' },
);

/**
 * Dispatch with ledger-guarded replay safety: if a previous execution of
 * THIS step already got the provider to accept (kill between accept and
 * response), the replay suppresses the second dispatch instead of
 * repeating it. The suppression is recorded, not silent.
 */
const opDispatchStep = DBOS.registerStep(
  async (
    tag: string,
    operationId: string,
    opts?: { timeoutAfterAccept?: boolean },
  ): Promise<{ attemptId: string; state: string; suppressed: boolean }> => {
    const prior = await countAcceptances(pool, operationId);
    if (prior > 0) {
      await pool.query(`INSERT INTO app.p2_probe_log (workflow_id, mark) VALUES ($1, $2)`, [
        `p2-${tag}-provider`,
        'dispatch-suppressed-after-recovery',
      ]);
      return { attemptId: '(suppressed)', state: 'suppressed', suppressed: true };
    }
    let outcome;
    try {
      await assertNoPriorAcceptance(pool, operationId);
      outcome = await dispatchAttempt(pool, {
        operationId,
        inputTokens: 100,
        outputTokens: 50,
        provider: createLedgerProvider(pool, {
          holdAfterAcceptMs: probeHoldMs(process.env, PROVIDER_HOLD_ENV_VAR),
          timeoutAfterAccept: opts?.timeoutAfterAccept ?? false,
        }),
        caps: stagingCaps(),
      });
    } catch (err) {
      // Lost a genuine acceptance race (or a TOCTOU slice between the
      // pre-check above and the provider commit): record it explicitly.
      // The attempt is failed-before-acceptance, and the ledger still
      // holds exactly the winner's row — verified, never assumed.
      if (err instanceof ConflictError) {
        await pool.query(`INSERT INTO app.p2_probe_log (workflow_id, mark) VALUES ($1, $2)`, [
          `p2-${tag}-provider`,
          'contention-lost',
        ]);
        return { attemptId: '(contention-lost)', state: 'contention-lost', suppressed: true };
      }
      throw err;
    }
    return { attemptId: outcome.attemptId, state: outcome.state, suppressed: false };
  },
  { name: 'p2-op-dispatch' },
);

const opSettleStep = DBOS.registerStep(
  async (operationId: string, attemptId: string, actualMicro: number): Promise<string> => {
    await settle(pool, operationId, attemptId, actualMicro);
    return 'settled';
  },
  { name: 'p2-op-settle' },
);

/** Quarantine stale dispatching attempts (P3 recovery rule, idempotent transition). */
const quarantineStep = DBOS.registerStep(
  async (operationId: string): Promise<{ quarantined: number }> => {
    const rows = await recoverStaleAttempts(pool, 5000, operationId);
    return { quarantined: rows.length };
  },
  { name: 'p2-quarantine' },
);

const holdStep = DBOS.registerStep(
  async (ms: number): Promise<string> => {
    await new Promise((res) => setTimeout(res, ms));
    return `held-${ms}`;
  },
  { name: 'p2-hold' },
);

/** Normal durable-step workflow (T2 case 1). */
export const normalWorkflow = DBOS.registerWorkflow(
  async (input: { tag: string }): Promise<string> => {
    const id = `${input.tag}-normal`;
    await markStep(id, 'step-1');
    await holdStep(normalHoldMs());
    await markStep(id, 'step-2');
    return 'normal-done';
  },
  { name: 'p2-normal' },
);

/** Provider workflow (T2 case 2, T3): real P3 semantics over the staging ledger. */
export const providerWorkflow = DBOS.registerWorkflow(
  async (input: { tag: string }): Promise<string> => {
    const id = `${input.tag}-provider`;
    await markStep(id, 'pre-call');
    const { operationId } = await opSetupStep(input.tag);
    const dispatch = await opDispatchStep(input.tag, operationId);
    if (!dispatch.suppressed && dispatch.state === 'succeeded') {
      await opSettleStep(operationId, dispatch.attemptId, 30000);
    }
    await markStep(id, `post-call:${dispatch.state}`);
    return 'provider-done';
  },
  { name: 'p2-provider' },
);

/** Uncertain-attempt workflow (T2 case 3): response lost, attempt quarantined. */
export const uncertainWorkflow = DBOS.registerWorkflow(
  async (input: { tag: string }): Promise<string> => {
    const id = `${input.tag}-uncertain`;
    const { operationId } = await opSetupStep(`${input.tag}-uncertain`);
    const dispatch = await opDispatchStep(`${input.tag}-uncertain`, operationId, { timeoutAfterAccept: true });
    // 'suppressed' is also safe: a replay after a kill found the prior
    // acceptance and refused the second dispatch; the recovery probe then
    // verifies quarantine regardless of which path produced it.
    if (dispatch.state !== 'uncertain' && !dispatch.suppressed) {
      throw new Error(`p2-uncertain expected quarantined attempt, got ${dispatch.state}`);
    }
    await markStep(id, 'attempt-uncertain');
    return 'uncertain-held';
  },
  { name: 'p2-uncertain' },
);

/**
 * Recovery proof (operator-enqueued after restart): quarantine whatever is
 * stale, then PROVE the redispatch guard fires. If the guard ever passes
 * with a ledger acceptance present, this workflow fails loudly.
 */
export const recoverWorkflow = DBOS.registerWorkflow(
  async (input: { tag: string; operationId: string }): Promise<string> => {
    const id = `${input.tag}-recover`;
    const { quarantined } = await quarantineStep(input.operationId);
    await markStep(id, `recovered-uncertain:${quarantined}`);
    let refused = false;
    try {
      await assertNoPriorAcceptance(pool, input.operationId);
    } catch (err) {
      if (err instanceof ConflictError) refused = true;
      else throw err;
    }
    if (!refused) {
      throw new Error('recovery FAILED: redispatch guard allowed an already-accepted operation');
    }
    await markStep(id, 'redispatch-refused');
    const acceptances = await countAcceptances(pool, input.operationId);
    if (acceptances !== 1) {
      throw new Error(`recovery FAILED: expected exactly 1 provider acceptance, found ${acceptances}`);
    }
    await markStep(id, 'acceptance-count-1');
    return 'recovery-verified';
  },
  { name: 'p2-recover' },
);

interface HeartbeatHandle {
  bootId: string;
  stop(): void;
}

/** Register this boot as a generation and emit heartbeats until stopped. */
async function startHeartbeat(): Promise<HeartbeatHandle> {
  const bootId = randomUUID();
  const machineId = process.env.FLY_MACHINE_ID ?? 'local';
  const executorId = process.env.DBOS__VMID;
  if (!executorId) throw new Error('DBOS__VMID is required (boot wrapper assigns it worker-only)');
  await pool.query(
    `INSERT INTO app.p2_worker_generation (boot_id, machine_id, executor_id, state) VALUES ($1, $2, $3, 'starting')`,
    [bootId, machineId, executorId],
  );
  const beat = async (state: string): Promise<void> => {
    const t0 = Date.now();
    await sysPool.query('SELECT 1');
    const latency = Date.now() - t0;
    await pool.query(
      `UPDATE app.p2_worker_generation SET last_heartbeat = now(), sysdb_latency_ms = $2, state = $3 WHERE boot_id = $1`,
      [bootId, latency, state],
    );
  };
  await beat('ready');
  const timer = setInterval(() => {
    void beat('ready').catch((err) => console.error(`heartbeat FAILED: ${String(err).slice(0, 200)}`));
  }, P2_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return {
    bootId,
    stop() {
      clearInterval(timer);
    },
  };
}

async function main(): Promise<void> {
  let heartbeat: HeartbeatHandle | null = null;
  let shuttingDown = false;
  const stop = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`p2 probe worker received ${signal}: draining`);
    try {
      if (heartbeat) {
        await pool
          .query(`UPDATE app.p2_worker_generation SET state = 'draining' WHERE boot_id = $1`, [heartbeat.bootId])
          .catch(() => undefined);
      }
      const shutdown = DBOS.shutdown();
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 100000));
      await Promise.race([shutdown, timeout]);
      if (heartbeat) {
        await pool
          .query(`UPDATE app.p2_worker_generation SET state = 'stopped', shutdown_at = now() WHERE boot_id = $1`, [
            heartbeat.bootId,
          ])
          .catch(() => undefined);
        heartbeat.stop();
      }
      await pool.end().catch(() => undefined);
      await sysPool.end().catch(() => undefined);
      console.log('p2 probe worker stopped cleanly');
      process.exit(0);
    } catch (err) {
      console.error(`p2 probe worker shutdown FAILED: ${String((err as Error)?.message ?? err).slice(0, 300)}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  DBOS.setConfig({ name: P2_APP_NAME, systemDatabaseUrl: sysUrl, runMigrations: false });
  await DBOS.launch();
  await DBOS.registerQueue(P2_QUEUE);
  heartbeat = await startHeartbeat();
  console.log(`p2 probe worker up (queue: ${P2_QUEUE}, boot: ${heartbeat.bootId})`);
}

await main();
