/**
 * Packaging tests (no Docker, no database). Pin the production-install
 * contract that M1 broke: the staging worker command needs `tsx`, so `tsx`
 * must be a runtime dependency, and the Dockerfile must install exactly
 * the production set. The live proof (image build + in-image smoke) runs
 * in the p2-packaging CI job; these tests pin the static half.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('production dependency packaging (M1)', () => {
  test('tsx is a runtime dependency (worker command needs --import tsx)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies?.tsx).toBeDefined();
    expect(pkg.devDependencies?.tsx).toBeUndefined();
  });

  test('Dockerfile installs production-only deps and checks entrypoints', () => {
    const dockerfile = readFileSync('phase0/p2/Dockerfile.p2staging', 'utf8');
    expect(dockerfile).toContain('npm ci --omit=dev');
    expect(dockerfile).toContain('COPY phase0/ ./phase0/');
    expect(dockerfile).toContain('node --check phase0/p2/boot-worker.mjs');
  });

  test('Dockerfile bakes in no secrets or database URLs', () => {
    const dockerfile = readFileSync('phase0/p2/Dockerfile.p2staging', 'utf8');
    expect(dockerfile).not.toMatch(/postgres:\/\//i);
    expect(dockerfile).not.toMatch(/^\s*ENV\s+(P2_|DATABASE_URL)/im);
  });

  test('negative smoke test captures the exit code safely under bash -e (prompt24 Fix C)', () => {
    const workflow = readFileSync('.github/workflows/phase0.yml', 'utf8');
    // No bare `; test $?` after docker run: under bash -e the expected
    // nonzero exit kills the step before the assertion runs.
    expect(workflow).not.toMatch(/docker run[^\n]*;\s*test \$\?/);
    // Explicit init + || capture (exempt from -e) + exact-code assertion.
    expect(workflow).toContain('status=0');
    expect(workflow).toMatch(/ROLE=bogus[^\n]*\|\| status=\$\?/);
    expect(workflow).toContain('test "$status" -eq 2');
  });
});
