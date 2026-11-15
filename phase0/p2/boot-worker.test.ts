/**
 * boot-worker.mjs T1 tests (no Docker, no database). Each case spawns the
 * real wrapper with a scrubbed environment and asserts its exit code and
 * failure message. Nothing here initializes an executor; the T1 positive
 * case (real initialization) runs in CI against a postgres service
 * container (see phase0/p2/STAGING_ACCEPTANCE.md), never locally.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { resolveWorkerEntry } from './boot-worker.mjs';

const WRAPPER = 'phase0/p2/boot-worker.mjs';
// Port 1 never listens: connection attempts fail fast everywhere
// (ECONNREFUSED normally; EPERM inside restricted sandboxes — either way
// the wrapper must report unreachable and exit 2).
const DEAD_URL = 'postgres://u:p@127.0.0.1:1/phase0_p2boot';

function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'ROLE' ||
      key.startsWith('P2_') ||
      key.startsWith('DBOS__') ||
      key.startsWith('PG') ||
      key === 'DATABASE_URL'
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function runBoot(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [WRAPPER], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 60000,
  });
}

const BASE = {
  ROLE: 'worker',
  P2_SYSTEM_DATABASE_URL: DEAD_URL,
  P2_APPLICATION_DATABASE_URL: DEAD_URL,
};

describe('boot-worker T1 fail-closed (prompt18.1 §7)', () => {
  test('missing ROLE prevents startup', () => {
    const { ROLE: _r, ...rest } = BASE;
    const r = runBoot(scrubbedEnv(rest));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires ROLE=worker');
  });

  test('incorrect ROLE prevents startup', () => {
    const r = runBoot(scrubbedEnv({ ...BASE, ROLE: 'web' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires ROLE=worker');
  });

  test('missing system database URL prevents startup', () => {
    const { P2_SYSTEM_DATABASE_URL: _s, ...rest } = BASE;
    const r = runBoot(scrubbedEnv(rest));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('P2_SYSTEM_DATABASE_URL is required');
  });

  test('missing application database URL prevents startup', () => {
    const { P2_APPLICATION_DATABASE_URL: _a, ...rest } = BASE;
    const r = runBoot(scrubbedEnv(rest));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('P2_APPLICATION_DATABASE_URL is required');
  });

  test('non-postgres scheme prevents startup', () => {
    const r = runBoot(scrubbedEnv({ ...BASE, P2_SYSTEM_DATABASE_URL: 'mysql://u:p@127.0.0.1:1/db' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('must use postgres://');
  });

  test('conflicting DBOS VMID prevents startup', () => {
    const r = runBoot(scrubbedEnv({ ...BASE, DBOS__VMID: 'worker-2', P2_WORKER_ENTRY: './x.mjs' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('conflicting DBOS__VMID');
  });

  test('missing worker entrypoint prevents staging startup', () => {
    const r = runBoot(scrubbedEnv(BASE));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('P2_WORKER_ENTRY is required');
  });

  test('unreachable system database prevents startup before any import', () => {
    const r = runBoot(scrubbedEnv({ ...BASE, P2_WORKER_ENTRY: './x.mjs' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('P2_SYSTEM_DATABASE_URL unreachable');
  });

  test('explicit dry-run exits 0 with an unmistakable banner and initializes nothing', () => {
    const r = runBoot(
      scrubbedEnv({
        ...BASE, // dead URLs: exit 0 proves no database was contacted
        P2_WORKER_ENTRY: '/nonexistent-entry-xyz.mjs', // would fail loudly if imported
        P2_DRY_RUN: '1',
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NO WORKER INITIALIZED');
    expect(r.stdout).toContain('NOT A STAGING WORKER');
    expect(r.stdout).toContain('"dry_run":true');
  });

  test('dry-run still enforces static validation', () => {
    const { ROLE: _r, ...rest } = BASE;
    const r = runBoot(scrubbedEnv({ ...rest, P2_DRY_RUN: '1' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('requires ROLE=worker');
  });
});

describe('resolveWorkerEntry', () => {
  test('relative entries resolve from the working directory, absolute pass through', () => {
    expect(resolveWorkerEntry('./phase0/p2/probe-workflows.ts', '/app')).toBe(
      'file:///app/phase0/p2/probe-workflows.ts',
    );
    expect(resolveWorkerEntry('/app/x.mjs', '/repo')).toBe('/app/x.mjs');
    expect(resolveWorkerEntry('file:///app/x.mjs', '/repo')).toBe('file:///app/x.mjs');
  });
});
