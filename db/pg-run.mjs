// Entry point for `task test:pg`: gates honestly on Docker, then runs the
// real-PostgreSQL suite. Missing Docker locally prints NOT RUN and exits 0
// (documented developer path); in CI — where Docker is guaranteed — the same
// absence fails loudly instead of masquerading as a pass.
import { execFileSync, spawnSync } from 'node:child_process'

function dockerOk() {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15000 })
    return true
  } catch {
    return false
  }
}

if (!dockerOk()) {
  if (process.env.CI === 'true') {
    console.error('test:pg: FAIL: Docker is required in CI but unavailable')
    process.exit(1)
  }
  console.log('test:pg: NOT RUN (Docker unavailable on this host)')
  process.exit(0)
}

const res = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.pg.config.ts', ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
process.exit(res.status ?? 1)
