/**
 * Operator-command tests (no database). Arg parsing for the enqueue and
 * recovery commands, plus the recovery verdict table against a stub pool.
 * Live execution happens only in the authorized staging turn.
 */
import { describe, expect, test } from 'vitest';
import { parseArgs as parseEnqueue, probeWorkflowId } from './enqueue-probes.mjs';
import { parseArgs as parseRecovery, runRecoveryChecks } from './check-recovery.mjs';
import { needFlag, parseFlagPairs } from './argparse.mjs';

describe('enqueue-probes parseArgs', () => {
  test('enqueue requires a known workflow and tag', () => {
    expect(parseEnqueue(['enqueue', '--workflow', 'provider', '--tag', 't2'])).toEqual({
      cmd: 'enqueue',
      workflow: 'provider',
      tag: 't2',
      queue: 'p2',
    });
    expect(() => parseEnqueue(['enqueue', '--workflow', 'bogus', '--tag', 't'])).toThrow(/must be one of/);
    expect(() => parseEnqueue(['enqueue', '--workflow', 'normal'])).toThrow(/--tag/);
  });

  test('recover requires tag and operation', () => {
    expect(parseEnqueue(['recover', '--tag', 't3', '--op', 'op-1'])).toEqual({
      cmd: 'recover',
      tag: 't3',
      op: 'op-1',
      queue: 'p2',
    });
    expect(() => parseEnqueue(['recover', '--tag', 't3'])).toThrow(/--op/);
  });

  test('status, logs, and generations parse', () => {
    expect(parseEnqueue(['status', '--id', 'w-1'])).toEqual({ cmd: 'status', id: 'w-1' });
    expect(parseEnqueue(['logs', '--tag', 't2'])).toEqual({ cmd: 'logs', tag: 't2' });
    expect(parseEnqueue(['generations'])).toEqual({ cmd: 'generations', executor: '' });
    expect(parseEnqueue(['generations', '--executor', 'worker-1'])).toEqual({ cmd: 'generations', executor: 'worker-1' });
    expect(() => parseEnqueue(['bogus'])).toThrow(/unknown command/);
    expect(() => parseEnqueue([])).toThrow(/unknown command/);
  });

  test('probe workflow IDs derive deterministically', () => {
    expect(probeWorkflowId('t2', 'normal')).toBe('p2-t2-normal');
  });
});

describe('check-recovery parseArgs', () => {
  test('requires op and tag; recovery expectation is opt-in', () => {
    expect(parseRecovery(['--op', 'op-1', '--tag', 't3'])).toEqual({ op: 'op-1', tag: 't3', expectRecovery: false });
    expect(parseRecovery(['--op', 'op-1', '--tag', 't3', '--expect-recovery', '1'])).toEqual({
      op: 'op-1',
      tag: 't3',
      expectRecovery: true,
    });
    expect(() => parseRecovery(['--op', 'op-1'])).toThrow(/--tag/);
  });
});

describe('strict operator parsing (m1)', () => {
  test('bare flags never consume the next flag or vanish silently', () => {
    expect(() => parseFlagPairs(['--tag'], ['tag'])).toThrow(/requires a value/);
    expect(() => parseFlagPairs(['--op', '--tag', 't'], ['op', 'tag'])).toThrow(/requires a value/);
    expect(() => parseRecovery(['--op', 'op-1', '--tag', 't3', '--expect-recovery'])).toThrow(/requires a value/);
  });

  test('unknown flags and positional strays are rejected', () => {
    expect(() => parseFlagPairs(['--bogus', 'x'], ['tag'])).toThrow(/unsupported flag --bogus/);
    expect(() => parseFlagPairs(['t3'], ['tag'])).toThrow(/expected --flag value/);
    expect(() => parseEnqueue(['logs', '--tag', 't', '--verbose', '1'])).toThrow(/unsupported flag/);
  });

  test('duplicate flags are rejected rather than last-wins (i-R2)', () => {
    expect(() => parseFlagPairs(['--tag', 'a', '--tag', 'b'], ['tag'])).toThrow(/duplicate flag --tag/);
    expect(() => parseEnqueue(['logs', '--tag', 'a', '--tag', 'b'])).toThrow(/duplicate flag --tag/);
  });

  test('queue overrides outside p2 are rejected', () => {
    expect(() => parseEnqueue(['enqueue', '--workflow', 'normal', '--tag', 't', '--queue', 'prod'])).toThrow(
      /unsupported queue/,
    );
    expect(parseEnqueue(['enqueue', '--workflow', 'normal', '--tag', 't', '--queue', 'p2'])).toEqual({
      cmd: 'enqueue',
      workflow: 'normal',
      tag: 't',
      queue: 'p2',
    });
  });

  test('needFlag reports the missing name', () => {
    expect(() => needFlag({}, 'tag')).toThrow(/--tag is required/);
    expect(needFlag({ tag: 't' }, 'tag')).toBe('t');
  });
});

describe('runRecoveryChecks', () => {
  function stubPool(fixture: {
    attempts?: Array<{ attempt_id: string; state: string }>;
    ledger?: Array<{ attempt_id: string }>;
    billing?: string;
    marks?: string[];
  }) {
    return {
      query: async (text: string) => {
        if (text.includes('FROM p3_attempt')) return { rows: fixture.attempts ?? [] };
        if (text.includes('FROM app.p2_provider_ledger')) return { rows: fixture.ledger ?? [] };
        if (text.includes('FROM p3_operation')) {
          return { rows: fixture.billing ? [{ billing_state: fixture.billing }] : [] };
        }
        if (text.includes('FROM app.p2_probe_log')) {
          return { rows: (fixture.marks ?? []).map((mark) => ({ mark, n: 1 })) };
        }
        throw new Error(`unexpected query in stub: ${text.slice(0, 60)}`);
      },
    } as unknown as Parameters<typeof runRecoveryChecks>[0];
  }

  const spec = { op: 'op-1', tag: 't3', expectRecovery: true };

  test('clean post-kill recovery passes every assertion', async () => {
    const pool = stubPool({
      attempts: [{ attempt_id: 'a1', state: 'uncertain' }],
      ledger: [{ attempt_id: 'a1' }],
      billing: 'reserved',
      marks: ['redispatch-refused', 'acceptance-count-1'],
    });
    const verdicts = await runRecoveryChecks(pool, spec);
    expect(verdicts.every((v) => v.pass)).toBe(true);
    expect(verdicts.map((v) => v.name)).toContain('exactly-one-acceptance');
  });

  test('a second acceptance fails exactly-one-acceptance', async () => {
    const pool = stubPool({
      attempts: [
        { attempt_id: 'a1', state: 'uncertain' },
        { attempt_id: 'a2', state: 'succeeded' },
      ],
      ledger: [{ attempt_id: 'a1' }, { attempt_id: 'a2' }],
      billing: 'settled',
      marks: ['redispatch-refused', 'acceptance-count-1'],
    });
    const verdicts = await runRecoveryChecks(pool, spec);
    expect(verdicts.find((v) => v.name === 'exactly-one-acceptance')?.pass).toBe(false);
  });

  test('phantom ledger rows fail dispatch-integrity', async () => {
    const pool = stubPool({
      attempts: [{ attempt_id: 'a1', state: 'uncertain' }],
      ledger: [{ attempt_id: 'ghost' }],
      billing: 'reserved',
      marks: [],
    });
    const verdicts = await runRecoveryChecks(pool, { ...spec, expectRecovery: false });
    expect(verdicts.find((v) => v.name === 'dispatch-integrity')?.pass).toBe(false);
    expect(verdicts.some((v) => v.name === 'recovery-marks-present')).toBe(false);
  });

  test('lingering dispatching attempts fail no-unresolved-dispatching', async () => {
    const pool = stubPool({
      attempts: [{ attempt_id: 'a1', state: 'dispatching' }],
      ledger: [{ attempt_id: 'a1' }],
      billing: 'reserved',
    });
    const verdicts = await runRecoveryChecks(pool, { ...spec, expectRecovery: false });
    expect(verdicts.find((v) => v.name === 'no-unresolved-dispatching')?.pass).toBe(false);
  });

  test('a refunded operation fails operation-not-blindly-refunded', async () => {
    const pool = stubPool({
      attempts: [{ attempt_id: 'a1', state: 'uncertain' }],
      ledger: [{ attempt_id: 'a1' }],
      billing: 'refunded',
    });
    const verdicts = await runRecoveryChecks(pool, { ...spec, expectRecovery: false });
    expect(verdicts.find((v) => v.name === 'operation-not-blindly-refunded')?.pass).toBe(false);
  });
});
