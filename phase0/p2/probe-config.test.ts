/**
 * probe-config + generations unit tests (no database). Pin pool sizing,
 * queue naming, workflow-ID derivation, generation activity/overlap
 * classification, and the liveness/readiness/heartbeat split.
 */
import { describe, expect, test } from 'vitest';
import {
  NORMAL_HOLD_MAX_MS,
  PROBE_HOLD_MAX_MS,
  P2_QUEUE,
  P2_WORKER_DATASOURCE_POOL_MAX,
  normalHoldMs,
  probeAppPoolOptions,
  probeHoldMs,
  probeWorkflowId,
  stagingCaps,
} from './probe-config.js';
import {
  GENERATION_STALE_AFTER_MS,
  arbitrateReplacement,
  classifyGeneration,
  isGenerationActive,
  overlappingExecutors,
  staleGenerations,
  type GenerationRow,
} from './generations.js';

describe('probe-config', () => {
  test('queue name and worker datasource pool follow V2.1 §9', () => {
    expect(P2_QUEUE).toBe('p2');
    expect(P2_WORKER_DATASOURCE_POOL_MAX).toBe(8);
    const opts = probeAppPoolOptions('postgres://x/y', 'probe');
    expect(opts.max).toBe(8);
    expect(opts.options).toContain('search_path=app');
    expect(opts.application_name).toBe('probe');
  });

  test('workflow IDs are deterministic per tag and reject bad tags', () => {
    expect(probeWorkflowId('run7', 'normal')).toBe('p2-run7-normal');
    expect(probeWorkflowId('run7', 'normal')).toBe(probeWorkflowId('run7', 'normal'));
    for (const bad of ['', 'a b', 'a/b', "a'b", 'a;b']) {
      expect(() => probeWorkflowId(bad, 'normal')).toThrow(/invalid tag/);
    }
  });

  test('staging caps are fixed test budgets', () => {
    const caps = stagingCaps();
    expect(caps.budgetUsdMicro).toBeGreaterThan(0);
    expect(caps.maxProviderAttempts).toBeGreaterThanOrEqual(1);
    expect(stagingCaps()).toEqual(caps);
  });

  test('normal hold is bounded and refuses invalid values', () => {
    expect(NORMAL_HOLD_MAX_MS).toBe(300000);
    expect(normalHoldMs({})).toBe(0);
    expect(normalHoldMs({ P2_NORMAL_HOLD_MS: '' })).toBe(0);
    expect(normalHoldMs({ P2_NORMAL_HOLD_MS: '60000' })).toBe(60000);
    for (const bad of ['-1', 'abc', '1.5']) {
      expect(() => normalHoldMs({ P2_NORMAL_HOLD_MS: bad })).toThrow(/invalid P2_NORMAL_HOLD_MS/);
    }
    expect(() => normalHoldMs({ P2_NORMAL_HOLD_MS: String(NORMAL_HOLD_MAX_MS + 1) })).toThrow(/exceeds cap/);
  });

  test('provider hold shares the one bounded parser and limit (m-R2)', () => {
    expect(PROBE_HOLD_MAX_MS).toBe(NORMAL_HOLD_MAX_MS);
    expect(probeHoldMs({}, 'P2_PROVIDER_DELAY_MS')).toBe(0);
    expect(probeHoldMs({ P2_PROVIDER_DELAY_MS: '60000' }, 'P2_PROVIDER_DELAY_MS')).toBe(60000);
    for (const bad of ['-1', 'abc', '1.5', 'NaN', 'Infinity', String(PROBE_HOLD_MAX_MS + 1)]) {
      expect(() => probeHoldMs({ P2_PROVIDER_DELAY_MS: bad }, 'P2_PROVIDER_DELAY_MS')).toThrow(
        /invalid P2_PROVIDER_DELAY_MS|exceeds cap/,
      );
    }
  });
});

describe('generations', () => {
  const NOW = 1000000000000;
  function row(overrides: Partial<GenerationRow> = {}): GenerationRow {
    return {
      boot_id: 'boot-1',
      machine_id: 'm-1',
      executor_id: 'worker-1',
      started_at_ms: NOW - 60000,
      last_heartbeat_ms: NOW - 10000,
      state: 'ready',
      shutdown_at_ms: null,
      ...overrides,
    };
  }

  test('starting/ready/draining with fresh heartbeat are active; stopped/stale are not', () => {
    // M3 correction: draining still executes in-flight steps, so excluding
    // it could conceal a genuine overlap. Only stopped machines retire.
    expect(isGenerationActive(row(), NOW)).toBe(true);
    expect(isGenerationActive(row({ state: 'starting' }), NOW)).toBe(true);
    expect(isGenerationActive(row({ state: 'draining' }), NOW)).toBe(true);
    expect(isGenerationActive(row({ state: 'stopped' }), NOW)).toBe(false);
    expect(isGenerationActive(row({ last_heartbeat_ms: NOW - GENERATION_STALE_AFTER_MS - 1 }), NOW)).toBe(false);
  });

  test('overlap detection flags two simultaneously active generations of one executor', () => {
    const a = row({ boot_id: 'boot-a', machine_id: 'm-a' });
    const b = row({ boot_id: 'boot-b', machine_id: 'm-b' });
    expect(overlappingExecutors([a, b], NOW)).toEqual(['worker-1']);
    expect(overlappingExecutors([a, { ...b, state: 'stopped' }], NOW)).toEqual([]);
    expect(overlappingExecutors([a], NOW)).toEqual([]);
    expect(overlappingExecutors([{ ...a, executor_id: 'worker-1' }, { ...b, executor_id: 'worker-2' }], NOW)).toEqual([]);
  });

  test('stale generations are listed for attention, never auto-restarted by this module', () => {
    const fresh = row({ boot_id: 'fresh' });
    const stale = row({ boot_id: 'stale', last_heartbeat_ms: NOW - GENERATION_STALE_AFTER_MS - 1 });
    const staleDrain = row({
      boot_id: 'stale-drain',
      state: 'draining',
      last_heartbeat_ms: NOW - GENERATION_STALE_AFTER_MS - 1,
    });
    const stopped = row({ boot_id: 'stopped', state: 'stopped', last_heartbeat_ms: NOW - 99999999 });
    expect(staleGenerations([fresh, stale, staleDrain, stopped], NOW).map((r) => r.boot_id)).toEqual([
      'stale',
      'stale-drain',
    ]);
  });

  test('draining cannot conceal a second executor in overlap detection', () => {
    const draining = row({ boot_id: 'old', machine_id: 'm-old', state: 'draining' });
    const replacement = row({ boot_id: 'new', machine_id: 'm-new' });
    expect(overlappingExecutors([draining, replacement], NOW)).toEqual(['worker-1']);
  });

  test('SIGKILL-stale generations never read as live executors (i2)', () => {
    // Killed worker: heartbeat frozen before the threshold, machine gone.
    // A fresh replacement alongside must NOT flag an overlap.
    const killed = row({
      boot_id: 'killed',
      machine_id: 'm-gone',
      state: 'ready',
      last_heartbeat_ms: NOW - GENERATION_STALE_AFTER_MS - 1,
    });
    const replacement = row({ boot_id: 'new', machine_id: 'm-new' });
    expect(overlappingExecutors([killed, replacement], NOW)).toEqual([]);
    expect(isGenerationActive(killed, NOW)).toBe(false);
  });

  test('replacement blocked while the old machine runs, starts, or stops', () => {
    const old = row({ boot_id: 'old', machine_id: 'm-old' });
    for (const state of ['running', 'starting', 'stopping'] as const) {
      const v = arbitrateReplacement([old], { 'm-old': state }, NOW);
      expect(v.verdict).toBe('blocked');
      expect(v.reason).toContain('potentially active');
    }
  });

  test('replacement safe on stopped machine with consistent evidence', () => {
    const clean = row({ boot_id: 'old', machine_id: 'm-old', state: 'stopped' });
    expect(arbitrateReplacement([clean], { 'm-old': 'stopped' }, NOW).verdict).toBe('safe');
    const killed = row({
      boot_id: 'old',
      machine_id: 'm-old',
      state: 'ready',
      last_heartbeat_ms: NOW - GENERATION_STALE_AFTER_MS - 1,
    });
    expect(arbitrateReplacement([killed], { 'm-old': 'destroyed' }, NOW).verdict).toBe('safe');
  });

  test('missing machine state blocks as indeterminate (never assumed stopped)', () => {
    const old = row({ boot_id: 'old', machine_id: 'm-old' });
    const v = arbitrateReplacement([old], {}, NOW);
    expect(v.verdict).toBe('blocked');
    expect(v.reason).toContain('indeterminate');
    expect(arbitrateReplacement([], {}, NOW).verdict).toBe('blocked');
  });

  test('fresh heartbeat on a stopped machine blocks as contradictory', () => {
    const old = row({ boot_id: 'old', machine_id: 'm-old', state: 'ready' });
    const v = arbitrateReplacement([old], { 'm-old': 'stopped' }, NOW);
    expect(v.verdict).toBe('blocked');
    expect(v.reason).toContain('contradictory');
  });

  test('liveness, readiness, and heartbeat classify independently', () => {
    expect(classifyGeneration(row(), NOW)).toEqual({ liveness: 'alive', readiness: 'ready', heartbeat: 'fresh' });
    expect(classifyGeneration(row({ state: 'starting' }), NOW).readiness).toBe('not-ready');
    expect(classifyGeneration(row({ state: 'stopped' }), NOW)).toEqual({
      liveness: 'dead-or-gone',
      readiness: 'not-ready',
      heartbeat: 'fresh',
    });
    const staleAlive = classifyGeneration(row({ last_heartbeat_ms: NOW - GENERATION_STALE_AFTER_MS - 1 }), NOW);
    expect(staleAlive).toEqual({ liveness: 'alive', readiness: 'not-ready', heartbeat: 'stale' });
  });
});
