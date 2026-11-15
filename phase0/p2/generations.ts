/**
 * P2 worker-generation observation (addendum §4/§6). Generations are never
 * overwritten: each worker boot inserts one row, so a replacement cannot
 * conceal an executor overlap. Pure classifiers below; the worker updates
 * its own row, and acceptance queries count simultaneously active rows.
 *
 * Replacement arbitration lives in ./arbitrate.mjs (m-R3) so the
 * plain-node fencing guard shares the exact tested implementation
 * instead of a divergent copy; this module re-exports it typed.
 */
import {
  GENERATION_STALE_AFTER_MS as SHARED_STALE_AFTER_MS,
  arbitrateReplacement as arbitrateShared,
} from './arbitrate.mjs';

export type GenerationState = 'starting' | 'ready' | 'draining' | 'stopped';

export interface GenerationRow {
  boot_id: string;
  machine_id: string;
  executor_id: string;
  started_at_ms: number;
  last_heartbeat_ms: number;
  state: GenerationState;
  shutdown_at_ms: number | null;
}

export const GENERATION_STALE_AFTER_MS = SHARED_STALE_AFTER_MS;

/**
 * A generation counts as active while starting/ready/draining with a fresh
 * heartbeat. Draining is deliberately included: a draining worker still
 * executes in-flight steps, so excluding it could conceal a genuine
 * overlap (M3). Only a positively stopped machine retires a generation —
 * see arbitrateReplacement. Pure.
 */
export function isGenerationActive(row: GenerationRow, nowMs: number): boolean {
  if (row.state !== 'starting' && row.state !== 'ready' && row.state !== 'draining') return false;
  return nowMs - row.last_heartbeat_ms <= GENERATION_STALE_AFTER_MS;
}

/** Generations whose heartbeat lapsed without a clean stop (needs attention, not proof of restart). Pure. */
export function staleGenerations(rows: GenerationRow[], nowMs: number): GenerationRow[] {
  return rows.filter(
    (r) =>
      (r.state === 'starting' || r.state === 'ready' || r.state === 'draining') &&
      nowMs - r.last_heartbeat_ms > GENERATION_STALE_AFTER_MS,
  );
}

export type MachineState = 'running' | 'starting' | 'stopping' | 'stopped' | 'destroyed';
export type ReplacementVerdict = 'safe' | 'blocked';

/**
 * Three-state replacement arbitration (M3 refinement 1 + i2), re-exported
 * typed from the shared ./arbitrate.mjs implementation (m-R3). See that
 * module for the rule; behavior is identical by construction (same code).
 */
export function arbitrateReplacement(
  oldGenerations: GenerationRow[],
  machines: Map<string, MachineState> | Record<string, MachineState>,
  nowMs: number,
): { verdict: ReplacementVerdict; reason: string } {
  return arbitrateShared(oldGenerations, machines as Map<string, string> | Record<string, string>, nowMs) as {
    verdict: ReplacementVerdict;
    reason: string;
  };
}

/**
 * No-overlap acceptance: at most one active generation per executor ID.
 * Returns the offending executor IDs (empty = PASS). Pure.
 */
export function overlappingExecutors(rows: GenerationRow[], nowMs: number): string[] {
  const activeByExecutor = new Map<string, GenerationRow[]>();
  for (const row of rows.filter((r) => isGenerationActive(r, nowMs))) {
    const list = activeByExecutor.get(row.executor_id) ?? [];
    list.push(row);
    activeByExecutor.set(row.executor_id, list);
  }
  return [...activeByExecutor.entries()].filter(([, list]) => list.length > 1).map(([executor]) => executor);
}

/** Liveness/readiness/restart are distinct mechanisms (addendum §6); classify a row for exactly one question. Pure. */
export function classifyGeneration(
  row: GenerationRow,
  nowMs: number,
): { liveness: 'alive' | 'dead-or-gone'; readiness: 'ready' | 'not-ready'; heartbeat: 'fresh' | 'stale' } {
  const fresh = nowMs - row.last_heartbeat_ms <= GENERATION_STALE_AFTER_MS;
  return {
    liveness: row.state === 'stopped' ? 'dead-or-gone' : 'alive',
    readiness: row.state === 'ready' && fresh ? 'ready' : 'not-ready',
    heartbeat: fresh ? 'fresh' : 'stale',
  };
}
