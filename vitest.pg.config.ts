import { defineConfig } from 'vitest/config'

// Real-PostgreSQL product tests (Review 11: migration, locking, concurrency,
// and transactional semantics must prove against actual Postgres, never PGlite
// alone). Invoke via `task test:pg`, which gates honestly on Docker:
//
//   node db/pg-run.mjs  ->  npx vitest run --config vitest.pg.config.ts
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['db/**/*.pg.test.ts', 'server/**/*.pg.test.ts', 'scripts/**/*.pg.test.ts'],
    globalSetup: ['./db/pg-test-setup.ts'],
    testTimeout: 120000,
    // Files share one disposable server; databases are per-test (CREATE DATABASE).
    fileParallelism: false,
  },
})
