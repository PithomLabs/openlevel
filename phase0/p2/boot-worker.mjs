/**
 * P2 worker boot wrapper (Phase 0, isolated). Sole place that sets the
 * executor identity. Fail-closed: any misconfiguration exits non-zero
 * BEFORE any workflow code initializes, so a misconfigured worker can
 * never dequeue or recover as a ghost executor.
 *
 * Usage: ROLE=worker node phase0/p2/boot-worker.mjs
 * Env in: P2_EXPECTED_VMID (default "worker-1"),
 *   P2_SYSTEM_DATABASE_URL (required, DBOS system database),
 *   P2_APPLICATION_DATABASE_URL (required, probe/app data),
 *   P2_WORKER_ENTRY (required module path, unless P2_DRY_RUN=1).
 * Relative entries resolve from the process working directory (the repo
 * root locally, /app in the staging image) — never from this file's
 * directory, so one value works in every environment.
 *
 * Exit codes: 0 = worker initialized (import returned) or explicit dry
 * run completed; 2 = misconfiguration / failed preflight (nothing
 * initialized); anything else = the entrypoint itself failed (unmasked).
 *
 * Staging safety: a missing P2_WORKER_ENTRY fails closed. The ONLY exit-0
 * path without initializing a worker is the explicit P2_DRY_RUN=1 mode,
 * which prints an unmistakable banner and never runs staging setup.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

/** Resolve a worker entry to an importable specifier (relative → CWD). Pure. */
export function resolveWorkerEntry(entry, cwd) {
  if (entry.startsWith('.')) return pathToFileURL(join(cwd, entry)).href;
  return entry;
}

function fail(message) {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

// Live preflight helper (staging path only): the database must answer
// before any worker code initializes. Bounded; failures exit 2 unmasked.
async function checkConnectivity(label, url) {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    fail(`${label} unreachable: ${(err && err.message ? err.message : String(err)).slice(0, 200)}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  const EXPECTED_VMID = process.env.P2_EXPECTED_VMID ?? 'worker-1';
  const DRY_RUN = process.env.P2_DRY_RUN === '1';
  if (process.env.ROLE !== 'worker') {
    fail(`boot-worker.mjs requires ROLE=worker, got: ${process.env.ROLE}`);
  }
  const sysUrl = process.env.P2_SYSTEM_DATABASE_URL ?? '';
  const appUrl = process.env.P2_APPLICATION_DATABASE_URL ?? '';
  if (!sysUrl) fail('P2_SYSTEM_DATABASE_URL is required');
  if (!appUrl) fail('P2_APPLICATION_DATABASE_URL is required');
  for (const [label, url] of [
    ['P2_SYSTEM_DATABASE_URL', sysUrl],
    ['P2_APPLICATION_DATABASE_URL', appUrl],
  ]) {
    const scheme = url.split('://')[0]?.toLowerCase() ?? '';
    if (scheme !== 'postgres' && scheme !== 'postgresql') {
      fail(`${label} must use postgres:// or postgresql://`);
    }
  }
  if (process.env.DBOS__VMID && process.env.DBOS__VMID !== EXPECTED_VMID) {
    fail(`conflicting DBOS__VMID=${process.env.DBOS__VMID}, expected ${EXPECTED_VMID}`);
  }
  process.env.DBOS__VMID = EXPECTED_VMID;

  const entry = process.env.P2_WORKER_ENTRY ?? '';
  if (!entry && !DRY_RUN) {
    fail('P2_WORKER_ENTRY is required for staging startup (refusing to boot without a worker entrypoint)');
  }

  if (DRY_RUN) {
    // Explicit local dry-run ONLY: static validation above ran; no database
    // is contacted and no worker code is imported. This output must never be
    // mistaken for a successful staging worker boot.
    console.log('================================================================');
    console.log('P2 BOOT DRY RUN — NO WORKER INITIALIZED — NOT A STAGING WORKER');
    console.log('================================================================');
    console.log(
      JSON.stringify({
        dry_run: true,
        boot: 'worker',
        vmid: EXPECTED_VMID,
        entry: entry || '(none supplied)',
        static_checks: 'passed (ROLE, URL presence/shape, VMID)',
        live_checks: 'skipped (dry run contacts no database)',
        at: new Date().toISOString(),
      }),
    );
    process.exit(0);
  }

  await checkConnectivity('P2_SYSTEM_DATABASE_URL', sysUrl);
  await checkConnectivity('P2_APPLICATION_DATABASE_URL', appUrl);
  console.log(
    JSON.stringify({ boot: 'worker', vmid: EXPECTED_VMID, entry, preflight: 'both databases reachable', at: new Date().toISOString() }),
  );

  // Real worker entrypoint. Import failures propagate with stack + non-zero
  // exit — never masked, never converted into a success message.
  await import(resolveWorkerEntry(entry, process.cwd()));
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main();
}
