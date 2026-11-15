/**
 * probe-web tests (no database, no listening sockets). Router behavior
 * with a stub client, env validation via spawned rejection paths, and a
 * structural pin that the module cannot initialize a DBOS executor.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PROBE_SERVICE, routeRequest } from './probe-web.mjs';

function stubClient(statusById: Record<string, unknown>) {
  return {
    retrieveWorkflow: (id: string) => ({
      getStatus: async () => statusById[id] ?? null,
    }),
  };
}

describe('probe-web router', () => {
  test('health identifies the probe process, never the product app', async () => {
    const [status, body] = await routeRequest('/health', stubClient({}));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, service: PROBE_SERVICE, role: 'web' });
    expect(PROBE_SERVICE).toBe('openlevel-p2-probe');
  });

  test('workflow status reads through the client; unknown is 404', async () => {
    const client = stubClient({ 'w-1': { status: 'SUCCESS' } });
    const [okStatus, okBody] = await routeRequest('/p2/status?id=w-1', client);
    expect(okStatus).toBe(200);
    expect(okBody).toEqual({ status: 'SUCCESS' });
    const [missingStatus] = await routeRequest('/p2/status?id=nope', client);
    expect(missingStatus).toBe(404);
    const [badStatus] = await routeRequest('/p2/status', client);
    expect(badStatus).toBe(400);
  });

  test('unknown routes are 404', async () => {
    const [status] = await routeRequest('/admin', stubClient({}));
    expect(status).toBe(404);
  });
});

describe('probe-web client-only construction', () => {
  test('module initializes no executor (structural pin)', () => {
    const raw = readFileSync('phase0/p2/probe-web.mjs', 'utf8');
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).toContain('DBOSClient');
    for (const banned of ['DBOS.launch', 'registerWorkflow', 'registerStep', 'registerQueue', 'startWorkflow']) {
      expect(src).not.toContain(banned);
    }
  });

  test('wrong ROLE and missing URL refuse before listening', () => {
    const base = { ...process.env };
    for (const key of Object.keys(base)) {
      if (key === 'ROLE' || key.startsWith('P2_')) delete base[key];
    }
    const badRole = spawnSync(process.execPath, ['phase0/p2/probe-web.mjs'], {
      cwd: process.cwd(),
      env: { ...base, ROLE: 'worker', P2_SYSTEM_DATABASE_URL: 'postgres://u:p@h:5432/db' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(badRole.status).toBe(2);
    expect(badRole.stderr).toContain('requires ROLE=web');
    const noUrl = spawnSync(process.execPath, ['phase0/p2/probe-web.mjs'], {
      cwd: process.cwd(),
      env: { ...base, ROLE: 'web' },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(noUrl.status).toBe(2);
    expect(noUrl.stderr).toContain('P2_SYSTEM_DATABASE_URL is required');
  });
});
