/**
 * setup-staging.mjs tests (no Docker, no database). Cover URL validation,
 * operator-confirmation refusals, SQL splitting, and grant building. The
 * live path (migrate + apply against Neon staging) is operator-executed
 * only — these tests prove every refusal happens before any connection.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  connectGrant,
  createRoleStatement,
  parseStagingUrl,
  redactUrl,
  splitSqlStatements,
  stagingGrants,
} from './setup-staging.mjs';

const SYS = 'postgres://migrator:secret@staging-xyz.neon.tech:5432/stagedb?sslmode=require';
const APP = 'postgres://appuser:secret@staging-xyz.neon.tech:5432/stagedb?sslmode=require';

describe('parseStagingUrl', () => {
  test('accepts a well-formed staging URL', () => {
    expect(parseStagingUrl(SYS, 'P2_SYSTEM_DATABASE_URL')).toEqual({
      host: 'staging-xyz.neon.tech',
      db: 'stagedb',
      sslmode: 'require',
    });
  });

  test('rejects missing, malformed, and non-postgres URLs', () => {
    expect(() => parseStagingUrl('', 'X')).toThrow(/not set/);
    expect(() => parseStagingUrl('mysql://h/db?sslmode=require', 'X')).toThrow(/must use postgres/);
    expect(() => parseStagingUrl('postgres://%', 'X')).toThrow(/sslmode=require/);
    expect(() => parseStagingUrl('postgres://[::1', 'X')).toThrow(/malformed/);
  });

  test('rejects loopback hosts (local belongs to local/CI paths)', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(() => parseStagingUrl(`postgres://u:p@${host}:5432/db?sslmode=require`, 'X')).toThrow(/loopback/);
    }
  });

  test('rejects missing or weak sslmode and missing database', () => {
    expect(() => parseStagingUrl('postgres://u:p@h:5432/db', 'X')).toThrow(/sslmode=require/);
    expect(() => parseStagingUrl('postgres://u:p@h:5432/db?sslmode=prefer', 'X')).toThrow(/sslmode=require/);
    expect(() => parseStagingUrl('postgres://u:p@h:5432/?sslmode=require', 'X')).toThrow(/names no database/);
    expect(parseStagingUrl('postgres://u:p@h:5432/db?sslmode=verify-full', 'X').sslmode).toBe('verify-full');
  });
});

describe('splitSqlStatements', () => {
  test('splits statements and strips comments and empties', () => {
    expect(splitSqlStatements('-- hi\nCREATE TABLE a (x int);\n\nCREATE TABLE b (y int);')).toEqual([
      'CREATE TABLE a (x int)',
      'CREATE TABLE b (y int)',
    ]);
  });

  test('refuses dollar-quoted bodies', () => {
    expect(() => splitSqlStatements('CREATE FUNCTION f() AS $$ BEGIN END; $$ LANGUAGE plpgsql;')).toThrow(
      /dollar-quoted/,
    );
  });

  test('the real p2 schema splits into additive statements only', () => {
    const stmts = splitSqlStatements(readFileSync('phase0/p2/schema.sql', 'utf8'));
    expect(stmts.length).toBeGreaterThan(3);
    for (const s of stmts) {
      expect(s).not.toMatch(/DROP|TRUNCATE|DELETE FROM/i);
    }
  });

  test('semicolons inside line comments never become fragments (prompt26)', () => {
    expect(splitSqlStatements('-- a; b; c\nCREATE TABLE a (x int);')).toEqual(['CREATE TABLE a (x int)']);
    expect(splitSqlStatements('-- only a comment; with semicolons;\n')).toEqual([]);
    expect(splitSqlStatements('-- trailing comment without newline;')).toEqual([]);
  });

  test('inline comments with semicolons are stripped from their statement (prompt26)', () => {
    expect(splitSqlStatements('CREATE TABLE a (x int); -- trailing; comment\nCREATE TABLE b (y int);')).toEqual([
      'CREATE TABLE a (x int)',
      'CREATE TABLE b (y int)',
    ]);
  });

  test('semicolons inside quoted regions do not split (prompt26)', () => {
    expect(splitSqlStatements(`CREATE TABLE a (x text DEFAULT 'a;b');`)).toEqual([
      `CREATE TABLE a (x text DEFAULT 'a;b')`,
    ]);
    expect(splitSqlStatements('CREATE TABLE "we;ird" (x int);')).toEqual(['CREATE TABLE "we;ird" (x int)']);
  });

  test('escaped quotes do not end quoted regions early (prompt26)', () => {
    expect(splitSqlStatements(`INSERT INTO a VALUES ('it''s; fine');`)).toEqual([
      `INSERT INTO a VALUES ('it''s; fine')`,
    ]);
    expect(splitSqlStatements('CREATE TABLE "a""b;c" (x int);')).toEqual(['CREATE TABLE "a""b;c" (x int)']);
    // A quote char inside a line comment is inert, not a region opener.
    expect(splitSqlStatements(`-- don't split;\nCREATE TABLE a (x int);`)).toEqual(['CREATE TABLE a (x int)']);
  });

  test('the real p2 schema emits only CREATE statements, never comment text (prompt26)', () => {
    const stmts = splitSqlStatements(readFileSync('phase0/p2/schema.sql', 'utf8'));
    expect(stmts).toHaveLength(7);
    for (const s of stmts) {
      expect(s.startsWith('CREATE')).toBe(true);
      expect(s).not.toContain('--');
    }
    expect(stmts.join('\n')).not.toContain('safe to re-apply');
  });

  test('unsupported constructs fail closed: block comments and unterminated quotes (prompt26)', () => {
    expect(() => splitSqlStatements('CREATE TABLE a (x int); /* block; comment */')).toThrow(/block comment/);
    // The same markers inside strings or line comments are inert, not refusals.
    expect(splitSqlStatements(`SELECT '/* not a comment */';`)).toEqual([`SELECT '/* not a comment */'`]);
    expect(splitSqlStatements('-- /* not a comment */\nSELECT 1;')).toEqual(['SELECT 1']);
    expect(() => splitSqlStatements(`SELECT 'unterminated;`)).toThrow(/unterminated/);
  });
});

describe('stagingGrants', () => {
  test('grants DML on exactly the app proof + P3 wallet tables', () => {
    const grants = stagingGrants('app');
    expect(grants).toHaveLength(9);
    for (const t of ['p2_probe_log', 'p2_worker_generation', 'p2_provider_ledger', 'p3_operation', 'p3_attempt', 'p3_wallet', 'p3_settlement']) {
      expect(grants.join('\n')).toContain(`"app"."${t}"`);
    }
    expect(grants.join('\n')).not.toMatch(/public/i);
  });

  test('rejects invalid role names (no SQL injection via --app-role)', () => {
    for (const bad of ['app; DROP', '"x"', '', 'a b']) {
      expect(() => stagingGrants(bad)).toThrow(/invalid role name/);
    }
  });
});

describe('connectGrant + createRoleStatement', () => {
  test('CONNECT grant names database and role exactly', () => {
    expect(connectGrant('app', 'stagedb')).toBe('GRANT CONNECT ON DATABASE "stagedb" TO "app"');
    expect(() => connectGrant('app; DROP', 'stagedb')).toThrow(/invalid role name/);
    expect(() => connectGrant('app', 'stage db')).toThrow(/invalid database name/);
  });

  test('role creation is an idempotent NOLOGIN DO block (no password handling)', () => {
    const stmt = createRoleStatement('app');
    expect(stmt).toContain('CREATE ROLE "app" WITH NOLOGIN');
    expect(stmt).toContain('duplicate_object');
    expect(stmt).not.toMatch(/PASSWORD/i);
  });
});

describe('redactUrl', () => {
  test('redacts the password, keeps the shape', () => {
    expect(redactUrl(SYS)).toBe('postgres://migrator:<redacted>@staging-xyz.neon.tech:5432/stagedb?sslmode=require');
  });
});

describe('setup-staging CLI refusals (no database)', () => {
  function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('P2_') || key.startsWith('PG')) delete env[key];
    }
    return { ...env, ...extra };
  }

  function runSetup(args: string[], env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, ['phase0/p2/setup-staging.mjs', ...args], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 60000,
    });
  }

  const URLS = { P2_SYSTEM_DATABASE_URL: SYS, P2_APPLICATION_DATABASE_URL: APP };

  test('missing --confirm-db refuses before connecting', () => {
    const r = runSetup([], scrubbedEnv(URLS));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--confirm-db');
  });

  test('confirm mismatch refuses without touching the server', () => {
    const r = runSetup(['--confirm-db', 'wrongdb'], scrubbedEnv(URLS));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('does not match');
  });

  test('differing system/application databases refuse', () => {
    const other = 'postgres://u:p@staging-xyz.neon.tech:5432/otherdb?sslmode=require';
    const r = runSetup(['--confirm-db', 'stagedb'], scrubbedEnv({ ...URLS, P2_APPLICATION_DATABASE_URL: other }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('differ');
  });

  test('loopback URLs refuse (staging is remote)', () => {
    const local = 'postgres://u:p@127.0.0.1:5432/stagedb?sslmode=require';
    const r = runSetup(
      ['--confirm-db', 'stagedb'],
      scrubbedEnv({ P2_SYSTEM_DATABASE_URL: local, P2_APPLICATION_DATABASE_URL: local }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('loopback');
  });

  test('redirect env refuses', () => {
    const r = runSetup(['--confirm-db', 'stagedb'], scrubbedEnv({ ...URLS, PGSERVICE: 'x' }));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PGSERVICE');
  });

  test('schema file has no dollar quotes and qualifies proof tables to app', () => {
    const sql = readFileSync('phase0/p2/schema.sql', 'utf8');
    expect(sql).not.toContain('$$');
    for (const t of ['app.p2_probe_log', 'app.p2_worker_generation', 'app.p2_provider_ledger']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
    expect(sql).toMatch(/CREATE SCHEMA IF NOT EXISTS app/);
  });
});

describe('applyStagingSetup role ordering (prompt24 Fix B)', () => {
  // Static shape test: DBOS.migrate grants privileges to the runtime role,
  // so the role must be created first — and role creation is a
  // system-level operation, so it must run on ownSys, not ownApp. The live
  // CI proof uses identical superuser credentials for both pools and
  // therefore cannot detect a wrong-pool creation; this pins the target.
  // Runtime behavior (double apply, sentinel, as-role DML) stays covered
  // by verify-staging-apply.mjs on CI.
  test('role creation runs on ownSys before DBOS.migrate', () => {
    const src = readFileSync('phase0/p2/setup-staging.mjs', 'utf8');
    const body = src.slice(src.indexOf('export async function applyStagingSetup'));
    expect(body).toContain('await ownSys.query(createRoleStatement(appRole))');
    expect(body).not.toContain('ownApp.query(createRoleStatement');
    const createdAt = body.indexOf('ownSys.query(createRoleStatement(appRole))');
    const migratedAt = body.indexOf('await DBOS.migrate(');
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(migratedAt).toBeGreaterThanOrEqual(0);
    expect(createdAt).toBeLessThan(migratedAt);
  });
});
