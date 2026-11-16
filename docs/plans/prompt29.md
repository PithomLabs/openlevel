No additional clarification is needed. I'll assume you're using macOS, and interpret “one sleek uptime” as **one convenient command that starts the complete local application, waits until it's ready, and opens the UI in your browser**.

I've also checked the current OpenLevel source. There is already a useful local demo server using PGlite, seeded demo data, and offline integration stubs. The frontend runs at port `5273`, while its backend runs at `8790`. The project currently requires Node 22 or newer, and GitHub Actions is pinned to Node 22\. [Local development server](https://github.com/PithomLabs/openlevel/blob/master/server/dev-server.ts?utm_source=chatgpt.com) · [Vite configuration](https://github.com/PithomLabs/openlevel/blob/master/vite.config.ts?utm_source=chatgpt.com) · [Package configuration](https://github.com/PithomLabs/openlevel/blob/master/package.json?utm_source=chatgpt.com)

One important deployment detail: the existing `phase0/p2/fly.staging.toml` is for the isolated P2 proof application, not the complete OpenLevel product. The agent must not mistake it for the product deployment configuration.

## **Coding agent prompt**

# **Prompt 29 — OpenLevel Developer Workstation, CLI Toolchain, and Taskfile Automation**

## **Mission**

Turn the OpenLevel repository and developer workstation into a convenient, agent-friendly development environment.

The objective is to eliminate the need for the developer or coding agents to memorize installation procedures, test commands, database commands, or deployment CLI syntax.

Install the required local development tools, create a root-level `Taskfile.yml`, and establish a consistent command interface for:

* Local development and UI preview.  
* Node.js and PostgreSQL management.  
* Database initialization, migration, and testing.  
* Unit, integration, and application testing.  
* Typechecking, linting where configured, and builds.  
* Fly.io application inspection and deployment commands.  
* Neon project and database management commands.  
* Toolchain diagnostics and environment verification.

The developer uses macOS. Prefer Homebrew for system-level installations when available.

The primary acceptance criterion is:

```
task dev
```

This single command must start the complete local OpenLevel application, wait until both frontend and backend are responsive, print the URLs and demo credentials, and open the application in the default browser.

The developer must not need to remember or manually coordinate multiple terminal commands.

---

# **1\. Begin with repository reconnaissance**

Before installing anything or modifying files, inspect the actual working tree and repository.

Confirm:

* Repository root and active Git branch.  
* Root `package.json` and package scripts.  
* Existing Node engine requirements.  
* Node version pinned in GitHub Actions.  
* Existing PostgreSQL schemas and migrations.  
* Existing database implementation and test infrastructure.  
* Existing local development server.  
* Existing Vite configuration.  
* Existing `.env.example`.  
* Existing Fly.io configuration files.  
* Existing Neon architecture documentation.  
* Existing `AGENTS.md`, development documentation, and Taskfiles.

Important known repository details to verify against the working tree:

### **Node.js**

`package.json` currently specifies:

```
"engines": {
  "node": ">=22.0.0"
}
```

`.github/workflows/phase0.yml` currently pins:

```
NODE_VERSION: "22"
```

Do not silently upgrade the project's CI runtime or alter its compatibility requirements.

### **Existing application scripts**

The root package currently includes:

```
npm run dev
npm run dev:server
npm run dev:local
npm run build
npm run migrate
npm run seed
npm run typecheck
npm test
npm run test:phase0:unit
npm run test:phase0:integration
npm run test:env:up
npm run test:env:down
```

Verify every script before using it.

### **Existing local development environment**

`server/dev-server.ts` currently provides:

* An in-process PGlite database.  
* Automatic schema initialization.  
* Demo data seeding.  
* A canned AI response implementation.  
* A fake Chatwoot sender.  
* An API server on port `8790`.  
* Demo login:  
  * Email: `admin@acmecorp.com`  
  * Password: `openlevel`

The frontend Vite server runs on port `5273` and proxies `/api` requests to the backend on port `8790`.

The development server is an offline demo environment, not production infrastructure. Its in-memory database resets when restarted.

Do not replace this working development arrangement with a Neon database or live third-party integrations.

---

# **2\. Install the local toolchain**

Install the latest stable versions appropriate for macOS.

Use official documentation and verify the current versions at execution time rather than trusting stale version numbers in this prompt.

## **2.1 PostgreSQL**

Install the latest stable production PostgreSQL major version.

As of November 16, 2026, PostgreSQL 18.7 is the latest stable release. PostgreSQL 19 is still in release-candidate status and must not be treated as the production-stable release.

Prefer:

```
brew install postgresql@18
```

Start the local PostgreSQL service:

```
brew services start postgresql@18
```

Verify:

```
psql --version
pg_isready
```

Establish a dedicated local OpenLevel development database and role only when needed.

Requirements:

* Do not overwrite or destroy an existing database.  
* Do not modify existing PostgreSQL clusters without inspection.  
* Do not change existing database ownership or permissions indiscriminately.  
* Keep local development databases separate from Neon.  
* Do not expose database passwords in terminal output.  
* Do not use production or staging connection strings.

The GitHub Actions P2 proof currently uses PostgreSQL 16.16. Preserve that CI version and document the distinction between local PostgreSQL 18 and CI PostgreSQL 16\. Do not silently change CI compatibility to make local testing easier.

## **2.2 Node.js**

Install the latest supported Node.js LTS release, not a nightly, alpha, or odd-numbered Current release.

As of November 16, 2026, the official Node.js download page identifies Node.js 26.13.1 as the latest LTS.

Use a Node version manager such as `fnm` or an existing equivalent so multiple Node versions can coexist.

Required outcome:

* Latest Node.js LTS is installed.  
* Node.js 22 is also available for this repository.  
* OpenLevel development and testing continue to use Node 22 by default to match GitHub Actions.  
* Do not change `package.json` engines or GitHub Actions runtime pins without separate justification and review.

If a project version file is appropriate, add one that pins the project to Node 22 and configure the version manager to respect it.

Verify:

```
node --version
npm --version
```

Make the toolchain work in new macOS terminal sessions. Do not overwrite shell configuration files. Back them up before making any necessary idempotent additions.

## **2.3 Task binary**

Install the official Go Task CLI using Homebrew:

```
brew install go-task/tap/go-task
```

Verify:

```
task --version
```

Use the official Taskfile syntax and a supported version of the Taskfile schema.

## **2.4 Fly.io CLI**

Install:

```
brew install flyctl
```

Verify:

```
fly version
fly help
```

The command exposed by the CLI is `fly`.

Do not run `fly auth login`, create a Fly application, launch an application, or deploy anything during this task.

## **2.5 Neon CLI**

Use the current Neon CLI package, not an outdated installation guide.

The current CLI package is `neon`, and the executable is `neon`.

Install:

```
npm install --global neon@latest
```

Verify:

```
neon --version
neon --help
```

The legacy `neonctl` command remains a compatibility alias, but new Taskfile commands should use `neon`.

Do not run `neon init`, `neon auth`, `neon link`, or `neon env pull` during this task. These commands can authenticate, link projects, modify project configuration, or write environment files. They require separate owner authorization.

---

# **3\. Create the root Taskfile**

Create:

```
Taskfile.yml
```

The Taskfile must be the single, easy-to-discover entry point for everyday developer and coding-agent commands.

The first command a new agent should run is:

```
task --list
```

Provide clear task descriptions and useful namespaces.

Use Taskfile features instead of implementing an unnecessarily complicated custom command framework.

The Taskfile must:

* Use root-relative paths.  
* Work from the repository root.  
* Provide understandable diagnostics.  
* Fail when a required tool or configuration is missing.  
* Avoid printing secrets.  
* Avoid assuming a particular user's absolute home directory.  
* Avoid destructive commands as defaults.  
* Reuse existing package scripts instead of duplicating them.  
* Support configurable ports and application variables where appropriate.  
* Provide a `task doctor` command that checks the environment.

## **3.1 Recommended task namespaces**

Implement tasks based on actual repository capabilities.

Suggested structure:

```
default
help
doctor

tools:versions
tools:check

deps:install
deps:audit

dev
dev:api
dev:web
dev:health
dev:open

db:version
db:status
db:start
db:stop
db:create
db:migrate
db:seed
db:psql

test
test:unit
test:integration
test:phase0
test:phase0:unit
test:phase0:integration

typecheck
build
check

fly:version
fly:apps
fly:status
fly:logs
fly:releases
fly:open
fly:deploy

neon:version
neon:help
neon:projects
neon:branches
neon:diff
neon:inspect
```

Do not create tasks that refer to nonexistent package scripts or configuration files.

Add descriptions explaining what each task does.

---

# **4\. One-command local development startup — highest priority**

Implement:

```
task dev
```

This is the most important user-facing developer convenience.

The goal is to launch the actual React/Vite OpenLevel UI and its local Hono API backend.

## **Required behavior**

1. Start the existing local PGlite backend using the appropriate existing script.  
2. Start the Vite frontend.  
3. Bind the frontend to `127.0.0.1` rather than exposing it to the local network.  
4. Wait until the backend health endpoint responds successfully.  
5. Wait until the Vite frontend responds successfully.  
6. Print both URLs.  
7. Automatically open the frontend in the default macOS browser.  
8. Print the demo login credentials.  
9. Display clear startup and shutdown messages.  
10. Forward logs from both processes.  
11. Handle Ctrl+C gracefully and terminate both child processes.  
12. Detect port conflicts and report them clearly instead of silently using another port.  
13. If either process exits unexpectedly, stop the other process and report the failure.

Expected output should be clean and easy to read, for example:

```
OpenLevel Local Development
────────────────────────────────────

API       http://localhost:8790
UI        http://localhost:5273
Health    http://localhost:8790/health

Demo Login
Email     admin@acmecorp.com
Password  openlevel

Opening OpenLevel in your browser...

Press Ctrl+C to stop.
```

Use the actual health endpoint and existing port settings. Confirm these values from the source code.

## **Implementation**

If Taskfile alone cannot coordinate long-running API and frontend processes cleanly, add a small Node.js launcher:

```
scripts/dev.mjs
```

The launcher must use Node's built-in process and networking APIs. Do not introduce a new npm dependency just to start two existing processes.

A possible responsibility split:

* `Taskfile.yml`: developer-facing task interface.  
* `scripts/dev.mjs`: process lifecycle, readiness checks, browser opening, logs, and graceful shutdown.

Provide an optional no-browser mode for automated environments.

Do not use real Anthropic, Chatwoot, Twilio, Stripe, or other external credentials in the local demo environment.

Make clear that the local PGlite demo is in-memory and resets on restart.

---

# **5\. Database development commands**

Provide convenient commands for managing local PostgreSQL.

Examples:

```
task db:version
task db:status
task db:start
task db:stop
task db:create
task db:migrate
task db:seed
task db:psql
```

Requirements:

* Use the installed local PostgreSQL service.  
* Use the repository's existing `db/migrate.ts` and `db/seed.ts`.  
* Use a dedicated local database.  
* Require `DATABASE_URL` for operations that need it.  
* Validate that database migration and seed tasks target an explicitly configured local development database.  
* Never run these tasks against Neon or production accidentally.  
* Never print connection strings or passwords.  
* Do not automatically drop or recreate databases.  
* Do not make `db:reset` a normal task. If a reset task is genuinely useful, require an explicit confirmation variable and restrict it to the local development database.

The local PGlite demo must remain independent of the external PostgreSQL service.

---

# **6\. Test and quality commands**

Expose existing project checks through Taskfile.

At minimum:

```
task typecheck
task test
task test:unit
task test:phase0:unit
task test:integration
task test:phase0:integration
task build
task check
```

Use actual package scripts.

Keep local-first verification as the default:

1. Run focused checks for modified code.  
2. Run unit tests.  
3. Run root and Phase 0 typechecks.  
4. Run integration and PostgreSQL-backed tests where local infrastructure supports them.  
5. Build the application.  
6. Report unavailable infrastructure checks as `NOT RUN`, not `PASS`.  
7. Use GitHub Actions as the final independent confirmation.

Do not replace real database or concurrency tests with mocks merely to avoid local PostgreSQL setup.

Do not weaken existing CI gates.

---

# **7\. Fly.io command interface**

Create convenient Fly CLI tasks so coding agents can discover commands instead of memorizing syntax.

Read the existing Fly configuration and architecture documents before creating deployment tasks.

Important existing repository fact:

`phase0/p2/fly.staging.toml` is an isolated P2 staging proof configuration. It is NOT the full OpenLevel product deployment configuration.

There is currently no root-level `fly.toml` in the repository.

Therefore:

* Do not treat the P2 staging configuration as a general product deployment configuration.  
* Do not invent an application name, region, process topology, machine size, or production configuration.  
* Do not generate a speculative product `fly.toml`.  
* Do not use `fly launch` to create infrastructure.  
* Do not run a deployment during this task.

Provide read-only tasks where configuration is available:

```
task fly:version
task fly:apps
task fly:status FLY_APP=<app-name>
task fly:logs FLY_APP=<app-name>
task fly:releases FLY_APP=<app-name>
task fly:open FLY_APP=<app-name>
```

Create a guarded generic deployment task:

```
task fly:deploy FLY_APP=<app-name> FLY_CONFIG=<config-path> CONFIRM_DEPLOY=yes
```

The task must:

* Require an explicit application name.  
* Require an explicit existing Fly configuration path.  
* Validate the configuration before deployment.  
* Require an explicit confirmation variable.  
* Never default to the P2 staging configuration.  
* Never silently deploy to production.  
* Never expose Fly access tokens or secrets.

The agent may create and verify the Taskfile definition, but must not execute the deployment task.

Document that owner authorization is required before any actual Fly deployment, scaling, machine stop/start, secret changes, or migration operation.

---

# **8\. Neon CLI command interface**

Provide a simple, discoverable interface for Neon.

Use the current `neon` executable.

Suggested commands:

```
task neon:version
task neon:help
task neon:projects
task neon:branches PROJECT_ID=<project-id>
task neon:diff PROJECT_ID=<project-id>
task neon:inspect
```

Use the current CLI's documented syntax and validate every command against `neon --help` or current official documentation.

Requirements:

* Do not hardcode Neon project IDs.  
* Do not hardcode branch IDs.  
* Do not print connection strings.  
* Do not automatically pull `.env` files.  
* Do not create, delete, reset, or modify Neon branches.  
* Do not run migrations against Neon.  
* Keep read-only operations distinguishable from mutating operations.  
* Require separate owner approval for any remote database mutation.

The CLI may be installed without authenticating it.

Do not run `neon auth` or `neon init` during this task.

---

# **9\. Agent documentation**

Create or update the root `AGENTS.md` with a compact development command reference.

The instructions must tell coding agents:

1. Run `task --list` to discover available commands.  
2. Run `task doctor` before starting substantial work.  
3. Use `task dev` to launch the local UI and API.  
4. Use the Taskfile for existing test, typecheck, build, database, and CLI tasks.  
5. Follow the Local-First, CI-Confirmed verification workflow.  
6. Never claim a test passed when it was not run.  
7. Do not inspect, print, or expose `.env` files or secrets.  
8. Do not use live Neon or Fly infrastructure for local tests.  
9. Do not execute cloud deployments or remote database mutations without separate explicit owner authorization.  
10. Do not invent new commands when a Taskfile command already exists.

If `AGENTS.md` already exists, preserve its existing instructions and make minimal additions.

Also create:

```
docs/development/LOCAL_DEVELOPMENT.md
```

Document:

* Installed toolchain.  
* Version compatibility.  
* Taskfile task catalog.  
* One-command local UI startup.  
* Demo login.  
* Local PostgreSQL setup.  
* Test workflow.  
* Fly CLI usage.  
* Neon CLI usage.  
* Local versus remote environment boundaries.  
* Troubleshooting common port and database errors.

Do not duplicate the entire Taskfile in the documentation. Explain how to discover commands using `task --list`.

---

# **10\. macOS workstation safety**

This is an installation and developer-experience task, not an authorization to operate cloud infrastructure.

You may install the requested local binaries and configure the local development workstation.

Before changing a system configuration file:

* Inspect the current configuration.  
* Preserve existing settings.  
* Make changes idempotently.  
* Back up files before modifying them.

Never:

* Print secrets.  
* Inspect `.env`.  
* Copy real credentials into Taskfile.  
* Commit credentials.  
* Change Fly or Neon credentials.  
* Log in to external services.  
* Create remote infrastructure.  
* Deploy an application.  
* Modify production or staging databases.  
* Delete an existing local PostgreSQL cluster.  
* Overwrite shell configuration or project configuration without review.

No Docker installation is required for this task. Use the local PostgreSQL server for checks that can run against it. Preserve Docker-backed CI tests that require Testcontainers or other container-specific behavior.

---

# **11\. Verification requirements**

Do not declare completion merely because the tools appear in PATH.

## **Toolchain verification**

Capture:

```
node --version
npm --version
psql --version
pg_isready
task --version
fly version
neon --version
```

Confirm that the project selects Node 22 when running repository tasks, while the latest LTS is installed and available.

## **Taskfile verification**

Run:

```
task --list
task doctor
task --dry dev
task --dry typecheck
task --dry test:phase0:unit
```

Review the dry-run output for accidental cloud operations, secrets, incorrect paths, or unexpected database targets.

## **Actual local UI verification**

Run:

```
task dev
```

Prove that:

* Backend health responds successfully.  
* Frontend responds successfully.  
* Browser opens the correct URL.  
* Login page renders.  
* Demo login succeeds.  
* The main application dashboard or assistant page renders.  
* API requests from the UI succeed.  
* Ctrl+C terminates both processes cleanly.

If a browser automation tool is available, use it to capture actual evidence of the rendered interface. Do not claim the UI works based only on an HTTP 200 from Vite.

## **Database verification**

Verify:

* PostgreSQL service starts and stops.  
* Local development database can be inspected.  
* Existing schema migration command works against the intended local database.  
* Seed command works against the isolated local development database.  
* Database diagnostics never expose secrets.

Do not run destructive database tests.

## **Test verification**

Run applicable local tests, unit checks, typechecks, and builds.

Record exact commands and results.

---

# **12\. Deliverables**

Provide:

1. Installed tools and actual versions.  
2. Installation method for each tool.  
3. Root `Taskfile.yml`.  
4. Any small supporting launcher such as `scripts/dev.mjs`.  
5. Root `AGENTS.md` updates.  
6. `docs/development/LOCAL_DEVELOPMENT.md`.  
7. Exact one-command local UI startup instructions.  
8. Task catalog and examples.  
9. Local PostgreSQL connection and service details, without exposing credentials.  
10. Verification matrix with PASS, FAIL, and NOT RUN.  
11. Any remaining manual steps requiring owner interaction.  
12. Exact Git diff and modified/untracked file inventory.

Keep the implementation lean. Do not add a general-purpose deployment framework or unnecessary dependencies.

Do not commit or push changes.

Do not authenticate to Fly.io or Neon.

Do not deploy or mutate cloud infrastructure.

Stop after local implementation, verification, and adversarial review.

---

## **Definition of Done**

The developer should be able to open a new terminal in the OpenLevel repository and use:

```
task --list
```

to discover the project commands, then:

```
task doctor
```

to validate the machine, and:

```
task dev
```

to launch the actual OpenLevel UI in the browser.

The coding agent should be able to use the same Taskfile commands for development, testing, database checks, Fly inspection, and Neon inspection without memorizing command syntax.

**Guiding principle: One command to start. One Taskfile to remember. Local-first verification. Owner-controlled deployment.**

## **Current versions and installation references**

These are the official references I used to ground the prompt:

* **Node.js:** current LTS is 26.13.1; project execution remains pinned to Node 22 for CI compatibility.  
   Download Node.js®  
* **PostgreSQL:** 18.7 is the latest stable version; PostgreSQL 19 is still RC2.  
   postgresql.org  
* **Task:** official Homebrew installation is `brew install go-task/tap/go-task`.  
   Task  
* **Fly.io:** official macOS Homebrew installation is `brew install flyctl`.  
   Fly Docs  
* **Neon:** use the newer `neon` package and `neon` executable; `neon init` has additional setup effects, so the prompt deliberately excludes it.  
   Neon+1

The main outcome I would prioritize is getting `task dev` working beautifully: one command, browser opens, demo data loads, and you can immediately inspect the real React application without configuring Neon or any external service.

