// Global setup for vitest.pg.config.ts: one disposable PostgreSQL 18.7 for
// the whole run (testcontainers). Provides the superuser URL; each test file
// carves per-test databases out of it (CREATE DATABASE), so tests never share
// state. Torn down at the end of the run.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

let container: StartedPostgreSqlContainer | null = null

export async function setup({ provide }: { provide: (key: string, value: unknown) => void }) {
  container = await new PostgreSqlContainer('postgres:18.7').withDatabase('pgtest').start()
  const url = container.getConnectionUri()
  provide('pgTestUrl', url)
  process.env.OPENLEVEL_PG_TEST_URL = url
}

export async function teardown() {
  await container?.stop()
  container = null
}
