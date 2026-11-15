/**
 * P2 staging web probe (infrastructure proof harness — explicitly NOT the
 * OpenLevel product web application, which still runs its own stack and
 * has no DBOS integration yet).
 *
 * A minimal HTTP process proving web/worker separation: it serves
 * liveness plus read-only workflow-status lookups through a CLIENT-ONLY
 * DBOSClient. It must never initialize an executor — no DBOS.launch,
 * registerWorkflow, registerStep, or registerQueue calls exist in this
 * file (pinned by unit test), and staging asserts the executor count
 * stays at exactly one worker while this process runs.
 *
 * Routes:
 *   GET /health            → { ok, service: 'openlevel-p2-probe', role: 'web' }
 *   GET /p2/status?id=<wf>  → DBOS workflow status JSON (404 when unknown)
 *
 * Env: ROLE=web (required), P2_SYSTEM_DATABASE_URL (required, postgres
 * scheme), PORT (default 8790, matches fly.staging.toml internal_port).
 * Listens on 0.0.0.0 (Fly internal networking). SIGTERM closes cleanly.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { DBOSClient } from '@dbos-inc/dbos-sdk';

export const PROBE_SERVICE = 'openlevel-p2-probe';

/**
 * Route one request with an already-created client. Pure apart from the
 * client call; unit-tested with a stub. Returns [statusCode, body].
 */
export async function routeRequest(url, client) {
  const parsed = new URL(url, 'http://probe.local');
  if (parsed.pathname === '/health') {
    return [200, { ok: true, service: PROBE_SERVICE, role: 'web' }];
  }
  if (parsed.pathname === '/p2/status') {
    const id = parsed.searchParams.get('id') ?? '';
    if (!id) return [400, { error: 'missing id query parameter' }];
    const status = await client.retrieveWorkflow(id).getStatus();
    if (!status) return [404, { error: `unknown workflow ${id}` }];
    return [200, status];
  }
  return [404, { error: 'not found' }];
}

async function main() {
  if (process.env.ROLE !== 'web') {
    console.error(`FATAL: probe-web.mjs requires ROLE=web, got: ${process.env.ROLE}`);
    process.exit(2);
  }
  const sysUrl = process.env.P2_SYSTEM_DATABASE_URL ?? '';
  if (!sysUrl) {
    console.error('FATAL: P2_SYSTEM_DATABASE_URL is required');
    process.exit(2);
  }
  const scheme = sysUrl.split('://')[0]?.toLowerCase() ?? '';
  if (scheme !== 'postgres' && scheme !== 'postgresql') {
    console.error('FATAL: P2_SYSTEM_DATABASE_URL must use postgres:// or postgresql://');
    process.exit(2);
  }
  const port = Number(process.env.PORT ?? '8790');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`FATAL: invalid PORT "${process.env.PORT ?? ''}"`);
    process.exit(2);
  }
  const client = await DBOSClient.create({ systemDatabaseUrl: sysUrl, systemDatabasePoolSize: 2 });
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const [status, body] = await routeRequest(req.url ?? '/', client);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String((err && err.message) || err).slice(0, 200) }));
      }
    })();
  });
  await new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(undefined)));
  console.log(JSON.stringify({ probe: 'web', service: PROBE_SERVICE, port, at: new Date().toISOString() }));
  const stop = async () => {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    await client.destroy().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main();
}
