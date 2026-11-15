/**
 * P2 probe operator commands (staging proof harness). Enqueue and inspect
 * probe workflows through a client-only DBOSClient — this module never
 * launches an executor. Run by the operator (e.g. via `fly ssh console`);
 * never exposed as a public route.
 *
 * Usage:
 *   node phase0/p2/enqueue-probes.mjs enqueue --workflow normal|provider|uncertain --tag <run-tag>
 *   node phase0/p2/enqueue-probes.mjs recover --tag <run-tag> --op <operation-id>
 *   node phase0/p2/enqueue-probes.mjs status --id <workflow-id>
 *   node phase0/p2/enqueue-probes.mjs logs --tag <run-tag>
 *   node phase0/p2/enqueue-probes.mjs generations [--executor <id>]
 *
 * Env: P2_SYSTEM_DATABASE_URL (DBOS client), P2_APPLICATION_DATABASE_URL
 * (probe-log/generation reads). Both validated like setup-staging
 * (postgres scheme, TLS, remote-only): staging is remote by definition.
 */
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { parseFlagPairs, needFlag } from './argparse.mjs';
import { parseStagingUrl, redactUrl } from './setup-staging.mjs';

const WORKFLOWS = ['normal', 'provider', 'uncertain'];
const QUEUE = 'p2';

/** Parse argv into a validated command spec. Pure (throws on misuse). */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'enqueue' || cmd === 'recover') {
    const flags = parseFlagPairs(rest, cmd === 'enqueue' ? ['workflow', 'tag', 'queue'] : ['tag', 'op', 'queue']);
    if (flags.queue && flags.queue !== QUEUE) {
      throw new Error(`usage error: unsupported queue "${flags.queue}" (want "${QUEUE}")`);
    }
    if (cmd === 'enqueue') {
      const workflow = needFlag(flags, 'workflow');
      if (!WORKFLOWS.includes(workflow)) throw new Error(`usage error: --workflow must be one of ${WORKFLOWS.join('|')}`);
      return { cmd, workflow, tag: needFlag(flags, 'tag'), queue: QUEUE };
    }
    return { cmd, tag: needFlag(flags, 'tag'), op: needFlag(flags, 'op'), queue: QUEUE };
  }
  if (cmd === 'status') {
    const flags = parseFlagPairs(rest, ['id']);
    return { cmd, id: needFlag(flags, 'id') };
  }
  if (cmd === 'logs') {
    const flags = parseFlagPairs(rest, ['tag']);
    return { cmd, tag: needFlag(flags, 'tag') };
  }
  if (cmd === 'generations') {
    const flags = parseFlagPairs(rest, ['executor']);
    return { cmd, executor: flags.executor || '' };
  }
  throw new Error(`usage error: unknown command "${cmd ?? '(missing)'}" (want enqueue|recover|status|logs|generations)`);
}

export function probeWorkflowId(tag, kind) {
  return `p2-${tag}-${kind}`;
}

function clientUrls() {
  const sys = parseStagingUrl(process.env.P2_SYSTEM_DATABASE_URL ?? '', 'P2_SYSTEM_DATABASE_URL');
  const app = parseStagingUrl(process.env.P2_APPLICATION_DATABASE_URL ?? '', 'P2_APPLICATION_DATABASE_URL');
  return { sys, app };
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
    clientUrls(); // validates both URLs (throws) before any connection is made
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(2);
  }
  if (spec.cmd === 'enqueue' || spec.cmd === 'recover') {
    const kind = spec.cmd === 'recover' ? 'recover' : spec.workflow;
    const workflowName = `p2-${kind}`;
    const workflowID = spec.cmd === 'recover' ? probeWorkflowId(spec.tag, 'recover') : probeWorkflowId(spec.tag, spec.workflow);
    const args = spec.cmd === 'recover' ? [{ tag: spec.tag, operationId: spec.op }] : [{ tag: spec.tag }];
    const client = await DBOSClient.create({
      systemDatabaseUrl: process.env.P2_SYSTEM_DATABASE_URL,
      systemDatabasePoolSize: 2,
    });
    try {
      const handle = await client.enqueue({ queueName: spec.queue, workflowName, workflowID }, ...args);
      console.log(JSON.stringify({ enqueued: workflowName, workflowID, queue: spec.queue, status: await handle.getStatus().then((s) => s?.status ?? null) }));
    } finally {
      await client.destroy().catch(() => undefined);
    }
    return;
  }
  if (spec.cmd === 'status') {
    const client = await DBOSClient.create({
      systemDatabaseUrl: process.env.P2_SYSTEM_DATABASE_URL,
      systemDatabasePoolSize: 2,
    });
    try {
      const handle = client.retrieveWorkflow(spec.id);
      console.log(JSON.stringify(await handle.getStatus(), null, 2));
    } finally {
      await client.destroy().catch(() => undefined);
    }
    return;
  }
  const pool = new Pool({ connectionString: process.env.P2_APPLICATION_DATABASE_URL, max: 1 });
  try {
    if (spec.cmd === 'logs') {
      const r = await pool.query(
        `SELECT workflow_id, mark, observed_at FROM app.p2_probe_log WHERE workflow_id LIKE $1 ORDER BY id`,
        [`${spec.tag}%`],
      );
      console.log(JSON.stringify(r.rows, null, 2));
    } else {
      const r = spec.executor
        ? await pool.query(`SELECT boot_id, machine_id, executor_id, db_user, state, started_at, last_heartbeat, shutdown_at FROM app.p2_worker_generation WHERE executor_id = $1 ORDER BY started_at`, [spec.executor])
        : await pool.query(`SELECT boot_id, machine_id, executor_id, db_user, state, started_at, last_heartbeat, shutdown_at FROM app.p2_worker_generation ORDER BY started_at`);
      console.log(JSON.stringify(r.rows, null, 2));
    }
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
