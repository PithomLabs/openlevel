# AGENTS.md — OpenLevel agent command reference

This repo's single command interface is the root `Taskfile.yml` (macOS + Linux).
Do not memorize bespoke shell commands when a task exists.

1. Start with `task --list` to discover commands.
2. Run `task doctor` before substantial work; fix FAIL items first.
3. Use `task dev` to view the UI (starts API + frontend, opens the browser).
4. Use Taskfile commands for test, typecheck, build, database, and CLI work.
5. Follow Local-First, CI-Confirmed verification: focused checks, then
   `task check`, then integration where local infra allows; GitHub Actions
   confirms committed code.
6. Report PASS / FAIL / NOT RUN truthfully. Never claim a check passed when
   it did not run.
7. Never print or inspect `.env`, credential files, or secret stores. Checking
   that a file exists is fine; reading it is not.
8. Never use live Neon/Fly resources for local tests. Local dev is PGlite
   (in-memory, resets on restart) plus an explicitly guarded local database.
9. Never deploy, scale, stop/start machines, change remote secrets, migrate
   remote databases, or mutate cloud resources without separate explicit
   owner authorization. `fly:deploy` is defined for future use and refuses
   unsafe invocations; do not run it.
10. Preserve Git state: no commits, pushes, merges, rebases, resets, or cleans
    unless the owner specifically requests that exact operation.

Docs: `docs/development/LOCAL_DEVELOPMENT.md` (workflow + troubleshooting),
`docs/development/TOOLCHAIN_COMPATIBILITY.md` (per-host version resolution).
Project notes: see `CLAUDE.md`.
