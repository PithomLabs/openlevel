/**
 * check-fencing tests (no database). Fixture transcripts proving the guard
 * accepts a true stop-verify-start ordering and rejects overlap, missing
 * stop evidence, and malformed input. The live transcript is captured by
 * the staging procedure; the guard only judges what it can see.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { validateFencingTranscript } from './check-fencing.mjs';
import { arbitrateReplacement, type GenerationRow, type MachineState } from './generations.js';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

function transcript(overrides: Record<string, unknown> = {}) {
  return {
    oldMachine: {
      id: 'm-old',
      transitions: [
        { state: 'stopping', at: iso(T0) },
        { state: 'stopped', at: iso(T0 + 5000) },
      ],
    },
    replacement: {
      bootId: 'b-new',
      machineId: 'm-new',
      executorId: 'worker-1',
      startedAt: iso(T0 + 30000),
    },
    generations: [
      {
        boot_id: 'b-old',
        machine_id: 'm-old',
        executor_id: 'worker-1',
        started_at_ms: T0 - 600000,
        last_heartbeat_ms: T0 + 4000,
        state: 'stopped',
        shutdown_at_ms: T0 + 5000,
      },
      {
        boot_id: 'b-new',
        machine_id: 'm-new',
        executor_id: 'worker-1',
        started_at_ms: T0 + 30000,
        last_heartbeat_ms: T0 + 40000,
        state: 'ready',
        shutdown_at_ms: null,
      },
    ],
    events: [
      { seq: 1, name: 'stop-requested', at: iso(T0 - 1000), source: 'operator', machineId: 'm-old' },
      { seq: 2, name: 'machine-stopped', at: iso(T0 + 6000), source: 'fly machine status', machineId: 'm-old' },
      { seq: 3, name: 'generation-inactive-verified', at: iso(T0 + 7000), source: 'generations query', machineId: 'm-old' },
      { seq: 4, name: 'replacement-start-requested', at: iso(T0 + 30000), source: 'operator', machineId: 'm-new', bootId: null },
      { seq: 5, name: 'replacement-ready-observed', at: iso(T0 + 45000), source: 'generations query', machineId: 'm-new', bootId: 'b-new' },
    ],
    ...overrides,
  };
}

function failedNames(t: unknown): string[] {
  return validateFencingTranscript(t)
    .filter((v) => !v.pass)
    .map((v) => v.name);
}

describe('validateFencingTranscript', () => {
  test('true stop-verify-start ordering passes every check', () => {
    const verdicts = validateFencingTranscript(transcript());
    expect(verdicts.every((v) => v.pass)).toBe(true);
    expect(verdicts.map((v) => v.name)).toContain('replacement-after-stop');
  });

  test('replacement start requested before stop observed fails ordering (collector clock)', () => {
    const t = transcript();
    t.events[3] = { ...t.events[3], at: iso(T0 + 1000) };
    expect(failedNames(t)).toContain('replacement-after-stop');
  });

  test('missing stop transition fails even with stop-claiming events (contradiction)', () => {
    const t = transcript();
    t.oldMachine.transitions = [{ state: 'stopping', at: iso(T0) }];
    const failed = failedNames(t);
    expect(failed).toContain('old-machine-stopped-observed');
    expect(failed).toContain('machine-evidence-agrees');
  });

  test('fresh-heartbeat old generation without clean stop fails retirement', () => {
    const t = transcript();
    t.generations[0] = { ...t.generations[0], state: 'ready', last_heartbeat_ms: T0 + 29000 };
    expect(failedNames(t).some((n) => n.startsWith('old-generation-retired:'))).toBe(true);
  });

  test('stale old generation on a stopped machine passes (SIGKILL case)', () => {
    const t = transcript();
    t.generations[0] = { ...t.generations[0], state: 'ready', last_heartbeat_ms: T0 - 600000 };
    expect(failedNames(t)).toEqual([]);
  });

  test('missing replacement generation row fails', () => {
    const t = transcript();
    t.generations = [t.generations[0]];
    expect(failedNames(t)).toContain('replacement-generation-recorded');
  });

  test('malformed transcripts throw (CLI reports them as failures)', () => {
    const { events: _dropped, ...noEvents } = transcript();
    for (const bad of [null, 42, {}, { oldMachine: {} }, transcript({ generations: 'nope' }), noEvents]) {
      expect(() => validateFencingTranscript(bad)).toThrow(/malformed transcript/);
    }
    const badTime = transcript();
    badTime.replacement.startedAt = 'not-a-time';
    expect(() => validateFencingTranscript(badTime)).toThrow(/not a valid timestamp/);
  });

  test('same-machine stop-verify-start passes (M3-R1)', () => {
    // Same machine stopped then restarted: the replacement generation shares
    // the old machine ID but must NOT be retired as an old generation.
    const t = transcript();
    t.replacement.machineId = 'm-old';
    t.generations[1] = { ...t.generations[1], machine_id: 'm-old' };
    t.events[3] = { ...t.events[3], machineId: 'm-old' };
    t.events[4] = { ...t.events[4], machineId: 'm-old' };
    expect(failedNames(t)).toEqual([]);
  });

  test('same-machine replacement with an unexpected extra boot fails', () => {
    const t = transcript();
    t.replacement.machineId = 'm-old';
    t.generations[1] = { ...t.generations[1], machine_id: 'm-old' };
    t.events[3] = { ...t.events[3], machineId: 'm-old' };
    t.events[4] = { ...t.events[4], machineId: 'm-old' };
    t.generations.push({
      boot_id: 'b-sneaky',
      machine_id: 'm-old',
      executor_id: 'worker-1',
      started_at_ms: T0 + 35000,
      last_heartbeat_ms: T0 + 40000,
      state: 'ready',
      shutdown_at_ms: null,
    });
    const failed = failedNames(t);
    expect(failed.some((n) => n.includes('b-sneaky'))).toBe(true);
  });

  test('replacement boot ID inconsistent with the machine fails', () => {
    const t = transcript();
    t.replacement.machineId = 'm-impostor';
    expect(failedNames(t).some((n) => n.includes('machine-consistent'))).toBe(true);
  });

  test('missing replacement generation fails', () => {
    const t = transcript();
    t.generations = [t.generations[0]];
    expect(failedNames(t)).toContain('replacement-generation-recorded');
  });
});

describe('event-sequence semantics (m-R1)', () => {
  test('missing events fail the sequence check', () => {
    const t = transcript();
    t.events = t.events.slice(0, 4);
    expect(failedNames(t)).toContain('event-sequence-valid');
  });

  test('reordered names fail even with correct seq numbers', () => {
    const t = transcript();
    const names = t.events.map((e) => e.name);
    t.events.forEach((e, i) => {
      e.name = names[(i + 1) % names.length];
    });
    expect(failedNames(t)).toContain('event-sequence-valid');
  });

  test('duplicate event names fail', () => {
    const t = transcript();
    t.events[4] = { ...t.events[4], name: 'machine-stopped' };
    expect(failedNames(t)).toContain('event-sequence-valid');
  });

  test('backward collector timestamps fail', () => {
    const t = transcript();
    t.events[2] = { ...t.events[2], at: iso(T0 - 5000) };
    expect(failedNames(t)).toContain('event-sequence-valid');
  });

  test('machine-ID inconsistency in events fails', () => {
    const t = transcript();
    t.events[1] = { ...t.events[1], machineId: 'm-elsewhere' };
    expect(failedNames(t)).toContain('event-sequence-valid');
  });

  test('boot-ID inconsistency in the ready event fails', () => {
    const t = transcript();
    t.events[4] = { ...t.events[4], bootId: 'b-elsewhere' };
    expect(failedNames(t)).toContain('event-sequence-valid');
  });

  test('missing event source fails', () => {
    const t = transcript();
    t.events[0] = { ...t.events[0], source: '' };
    expect(failedNames(t)).toContain('event-sequence-valid');
  });
});

describe('arbitration consistency (m-R3)', () => {
  test('validator imports the shared arbitration implementation (no divergent copy)', () => {
    const src = readFileSync('phase0/p2/check-fencing.mjs', 'utf8');
    expect(src).toContain("from './arbitrate.mjs'");
    expect(src).toContain('arbitrateReplacement');
  });

  function retiredVerdict(t: ReturnType<typeof transcript>): boolean {
    const v = validateFencingTranscript(t).find((x) => x.name === 'old-generation-retired:b-old');
    if (!v) throw new Error('missing retired verdict');
    return v.pass;
  }

  function oldRow(overrides: Partial<GenerationRow>): GenerationRow {
    return {
      boot_id: 'b-old',
      machine_id: 'm-old',
      executor_id: 'worker-1',
      started_at_ms: T0 - 600000,
      last_heartbeat_ms: T0 + 4000,
      state: 'stopped',
      shutdown_at_ms: T0 + 5000,
      ...overrides,
    };
  }

  const stoppedMachines: Record<string, MachineState> = { 'm-old': 'stopped' };

  test('validator and tested arbitration agree: clean stop', () => {
    const t = transcript();
    expect(arbitrateReplacement([oldRow({})], stoppedMachines, T0 + 30000).verdict).toBe('safe');
    expect(retiredVerdict(t)).toBe(true);
  });

  test('validator and tested arbitration agree: SIGKILL-stale retirement', () => {
    const t = transcript();
    t.generations[0] = { ...t.generations[0], state: 'ready', last_heartbeat_ms: T0 - 600000 };
    const direct = arbitrateReplacement(
      [oldRow({ state: 'ready', last_heartbeat_ms: T0 - 600000, shutdown_at_ms: null })],
      stoppedMachines,
      T0 + 30000,
    );
    expect(direct.verdict).toBe('safe');
    expect(retiredVerdict(t)).toBe(true);
  });

  test('validator and tested arbitration agree: contradictory fresh heartbeat', () => {
    const t = transcript();
    t.generations[0] = { ...t.generations[0], state: 'ready', last_heartbeat_ms: T0 + 29000 };
    const direct = arbitrateReplacement(
      [oldRow({ state: 'ready', last_heartbeat_ms: T0 + 29000, shutdown_at_ms: null })],
      stoppedMachines,
      T0 + 30000,
    );
    expect(direct.verdict).toBe('blocked');
    expect(retiredVerdict(t)).toBe(false);
  });
});
