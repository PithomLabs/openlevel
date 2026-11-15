/**
 * P2 probe shared configuration (staging proof harness, not production).
 * Pure builders so pool sizing, queue naming, and budget caps are pinned
 * by unit tests instead of scattered literals. Pool sizes follow V2.1 §9
 * (worker datasource 8 direct); the operator command pool is minimal (2)
 * because it issues sequential single-threaded calls.
 */
import type { SpendCaps } from '../p3/wallet.js';

export const P2_QUEUE = 'p2';
export const P2_APP_NAME = 'openlevel-p2';
export const P2_WORKER_DATASOURCE_POOL_MAX = 8;
export const P2_OPERATOR_POOL_MAX = 2;
export const P2_STAGING_AGENCY = 'p2-staging';
export const P2_HEARTBEAT_INTERVAL_MS = 30000;

export interface ProbePoolOptions {
  connectionString: string;
  max: number;
  application_name: string;
  /** P3 wallet tables are unqualified; staging keeps them in `app`. */
  options: string;
}

/** Application-pool options: search_path pins unqualified P3 tables to `app`. */
export function probeAppPoolOptions(appUrl: string, appName: string): ProbePoolOptions {
  return {
    connectionString: appUrl,
    max: P2_WORKER_DATASOURCE_POOL_MAX,
    application_name: appName,
    options: '-c search_path=app',
  };
}

/** Fixed staging test budget (monopoly money; never real charges). */
export function stagingCaps(): SpendCaps {
  return {
    budgetUsdMicro: 100000000,
    maxInputTokens: 100000,
    maxOutputTokens: 100000,
    maxProviderAttempts: 3,
    priceInMicroPerToken: 100,
    priceOutMicroPerToken: 200,
  };
}

/** Deterministic probe workflow IDs: stable per run tag for rerun-safe evidence. */
export function probeWorkflowId(tag: string, kind: 'normal' | 'provider' | 'uncertain'): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tag)) {
    throw new Error(`refusing probe: invalid tag "${tag}" (alphanumeric, dash, underscore)`);
  }
  return `p2-${tag}-${kind}`;
}

/**
 * Bounded probe-hold parser (M5, m-R2). One implementation and one limit
 * for every hold knob: unset/empty means no hold; anything else must be
 * an integer within the cap, else it throws. A typo'd hold must fail the
 * run loudly — never silently disable the window T2/T3 depend on.
 */
export const PROBE_HOLD_MAX_MS = 300000;
export function probeHoldMs(env: NodeJS.ProcessEnv, varName: string): number {
  const raw = env[varName] ?? '';
  if (raw === '') return 0; // unset or explicitly empty means no hold
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 0) {
    throw new Error(`invalid ${varName}="${raw}" (want an integer 0..${PROBE_HOLD_MAX_MS})`);
  }
  if (ms > PROBE_HOLD_MAX_MS) {
    throw new Error(`${varName}=${ms} exceeds cap ${PROBE_HOLD_MAX_MS}`);
  }
  return ms;
}

/** Normal-workflow hold: P2_NORMAL_HOLD_MS via the shared parser. */
export const NORMAL_HOLD_MAX_MS = PROBE_HOLD_MAX_MS;
export function normalHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  return probeHoldMs(env, 'P2_NORMAL_HOLD_MS');
}

/** Provider-hold knob name, shared with the worker (validated identically). */
export const PROVIDER_HOLD_ENV_VAR = 'P2_PROVIDER_DELAY_MS';
