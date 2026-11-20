import { z } from 'zod'
import { assertEnvDatabaseIdentity, resolveAppEnv } from './db-identity'

/**
 * Environment parsing with safe dev defaults. Secrets default to obviously
 * non-production values so the app runs locally without a .env, but outside
 * development those defaults are rejected at boot (see assertCloudSecret):
 * a deploy that forgets to override a secret fails fast instead of silently
 * shipping a well-known HMAC key an attacker could use to forge sessions or
 * webhook calls. DATABASE_URL is optional here and asserted at boot, so this
 * stays importable in tests without a database.
 *
 * APP_ENV (development|staging|production) identifies the deployment
 * environment; NODE_ENV stays a build hint (staging and production both run
 * NODE_ENV=production). Strict secret validation fires when EITHER signal
 * says non-development: APP_ENV is authoritative, and NODE_ENV=production
 * is a fail-closed backstop if APP_ENV is ever misconfigured.
 */
const DEV_SESSION_SECRET = 'dev-only-change-me'
const DEV_WEBHOOK_SECRET = 'dev-secret'
const MIN_CLOUD_SECRET_LEN = 32

const EnvSchema = z.object({
  DATABASE_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(1).default(DEV_SESSION_SECRET),
  CHATWOOT_WEBHOOK_SECRET: z.string().min(1).default(DEV_WEBHOOK_SECRET),
  PORT: z.coerce.number().int().positive().default(8790),
  NODE_ENV: z.string().default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  // The hub gateway's shared bearer for /federation/*. Optional + no dev default:
  // when unset the federation surface is inert (503). If present outside
  // development it must be long enough to resist guessing.
  FEDERATION_SERVICE_TOKEN: z.string().optional(),
  // Process role: web (HTTP + send-only boss), worker (consumers only),
  // all (combined). Validated by parseRole at boot; staging runs all.
  ROLE: z.string().optional(),
  // Hub gateway rails. Optional + no dev default: when unset, texting/push
  // honestly report "not set up" instead of silently dropping.
  GATEWAY_TEXT_URL: z.string().optional(),
  GATEWAY_PUSH_URL: z.string().optional(),
  INTERNAL_PUSH_SECRET: z.string().optional(),
  // Environment identity (FIND-03). FLY_APP_NAME is set by the Fly runtime
  // (verified platform contract); EXPECTED_DB_HOST is the owner-configured
  // exact database hostname for this environment (non-secret identifier).
  FLY_APP_NAME: z.string().optional(),
  EXPECTED_DB_HOST: z.string().optional(),
  // Staging outbound fence (N5/N15, G4): comma-separated recipient allowlist
  // (emails, E.164 phones). Optional at BOOT — staging processes start
  // without it — but every send refuses until it is set. Non-secret.
  STAGING_SINK_ALLOWLIST: z.string().optional(),
  // Federation tenant binding (N9): comma-separated location IDs the hub
  // gateway may name. When set, enforced in every environment; when unset,
  // staging refuses all tenant requests while other envs keep legacy trust.
  FEDERATION_TENANT_ALLOWLIST: z.string().optional(),
  // Workflow waits (N2/N3, G1): the pg-boss wait implementation must prove
  // durability before any environment may use it. Default OFF: a workflow
  // reaching a wait step fails loudly instead of arming an unsafe timer.
  // Exact 'true' enables; anything else (including 'yes'/'1') refuses.
  WORKFLOW_WAITS_ENABLED: z.enum(['true', 'false']).default('false'),
  // Restricted production preview (R14-03): exact 'true' + APP_ENV=production
  // means external effects are disabled (the side-effect policy refuses).
  // Boot validation governs this flag (Phase 2); the policy reads it raw.
  RESTRICTED_PREVIEW: z.string().optional(),
})

export type Config = z.infer<typeof EnvSchema>

export type AppEnv = Config['APP_ENV']

/** Outside development a secret must be overridden away from the shipped
 *  default and long enough (>=32 chars) to make HMAC forgery infeasible. */
function assertCloudSecret(name: string, value: string, devDefault: string): void {
  if (value === devDefault) {
    throw new Error(`${name} must be overridden outside development (it is still the dev default)`)
  }
  if (value.length < MIN_CLOUD_SECRET_LEN) {
    throw new Error(`${name} must be at least ${MIN_CLOUD_SECRET_LEN} characters outside development`)
  }
}

/** An optional bearer that is set outside development must resist guessing. */
function assertCloudBearer(name: string, value: string | undefined): void {
  if (value !== undefined && value.length < MIN_CLOUD_SECRET_LEN) {
    throw new Error(`${name} must be at least ${MIN_CLOUD_SECRET_LEN} characters outside development`)
  }
}

/** True for staging/production (or a production build with APP_ENV unset). */
export function isCloudEnv(config: Pick<Config, 'APP_ENV' | 'NODE_ENV'>): boolean {
  return config.APP_ENV !== 'development' || config.NODE_ENV === 'production'
}

/** True only for validated restricted production preview (APP_ENV=production + explicit flag). */
export function isPreviewMode(config: Pick<Config, 'APP_ENV' | 'RESTRICTED_PREVIEW'>): boolean {
  return config.APP_ENV === 'production' && config.RESTRICTED_PREVIEW === 'true'
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // No-silent-default (R14-11, §6 req 1-2): APP_ENV resolves from the RAW
  // value first — production builds and remote databases must name their
  // environment explicitly; only local-only execution gets the default.
  const appEnv = resolveAppEnv(env.APP_ENV, { nodeEnv: env.NODE_ENV, databaseUrl: env.DATABASE_URL })
  const config = EnvSchema.parse({ ...env, APP_ENV: appEnv })
  // Restricted-production-preview choice (§6 req 5): production must
  // explicitly choose preview or live — an unset flag refuses boot, so a
  // production app can never silently run live. The flag outside
  // production is a contradiction, not a no-op.
  if (config.APP_ENV === 'production') {
    if (config.RESTRICTED_PREVIEW !== 'true' && config.RESTRICTED_PREVIEW !== 'false') {
      throw new Error('refusing to boot: APP_ENV=production requires RESTRICTED_PREVIEW to be explicitly true or false')
    }
  } else if (config.RESTRICTED_PREVIEW === 'true') {
    throw new Error(`refusing to boot: RESTRICTED_PREVIEW=true contradicts APP_ENV=${config.APP_ENV} (preview is production-only)`)
  }
  if (isCloudEnv(config)) {
    assertCloudSecret('SESSION_SECRET', config.SESSION_SECRET, DEV_SESSION_SECRET)
    assertCloudSecret('CHATWOOT_WEBHOOK_SECRET', config.CHATWOOT_WEBHOOK_SECRET, DEV_WEBHOOK_SECRET)
    assertCloudBearer('FEDERATION_SERVICE_TOKEN', config.FEDERATION_SERVICE_TOKEN)
    assertCloudBearer('INTERNAL_PUSH_SECRET', config.INTERNAL_PUSH_SECRET)
  }
  // Environment/database contradiction check runs in EVERY environment
  // (including development): a dev process pointed at a production database
  // is exactly the accident this prevents.
  assertEnvDatabaseIdentity({
    appEnv: config.APP_ENV,
    databaseUrl: config.DATABASE_URL,
    flyAppName: config.FLY_APP_NAME,
    expectedDbHost: config.EXPECTED_DB_HOST,
  })
  return config
}
