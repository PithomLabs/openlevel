/**
 * check-inflight tests (no database). The precondition verdict table over
 * fixture evidence: exercised only when every workflow is genuinely
 * in-flight; completed-before-replacement must abort as NOT EXERCISED.
 */
import { describe, expect, test } from 'vitest';
import { ACTIVE_STATUSES, evaluateInflight, parseArgs } from './check-inflight.mjs';

function evidence(overrides = {}) {
  return {
    marks: ['step-1'],
    providerOp: { attempts: [{ attempt_id: 'a1', state: 'dispatching' }], ledgerCount: 1 },
    uncertainOp: { attempts: [{ attempt_id: 'a9', state: 'uncertain' }] },
    normalStatus: 'RUNNING',
    providerStatus: 'RUNNING',
    ...overrides,
  };
}

describe('check-inflight parseArgs', () => {
  test('requires a tag', () => {
    expect(parseArgs(['--tag', 't2'])).toEqual({ tag: 't2' });
    expect(() => parseArgs([])).toThrow(/--tag/);
  });
});

describe('evaluateInflight', () => {
  test('genuinely in-flight evidence is exercised', () => {
    expect(evaluateInflight(evidence())).toEqual([]);
  });

  test('completed normal workflow aborts as not exercised', () => {
    const reasons = evaluateInflight({ ...evidence(), marks: ['step-1', 'step-2'], normalStatus: 'SUCCESS' });
    expect(reasons.some((r) => r.includes('already completed step-2') || r.includes('step-2'))).toBe(true);
    expect(reasons.some((r) => r.includes('not provably active'))).toBe(true);
  });

  test('completed provider workflow aborts as not exercised', () => {
    const reasons = evaluateInflight({
      ...evidence(),
      marks: ['step-1', 'post-call:succeeded'],
      providerOp: { attempts: [{ attempt_id: 'a1', state: 'succeeded' }], ledgerCount: 1 },
      providerStatus: 'SUCCESS',
    });
    expect(reasons.some((r) => r.includes('post-call mark present'))).toBe(true);
    expect(reasons.some((r) => r.includes('no dispatching provider attempt') || r.includes('dispatching'))).toBe(true);
  });

  test('missing dispatch, missing acceptance, or missing quarantine each abort', () => {
    expect(evaluateInflight({ ...evidence(), providerOp: { attempts: [], ledgerCount: 0 } }).length).toBeGreaterThan(0);
    expect(
      evaluateInflight({
        ...evidence(),
        providerOp: { attempts: [{ attempt_id: 'a1', state: 'dispatching' }], ledgerCount: 0 },
      }).some((r) => r.includes('acceptance')),
    ).toBe(true);
    expect(
      evaluateInflight({ ...evidence(), uncertainOp: { attempts: [{ attempt_id: 'a9', state: 'dispatching' }] } }).some(
        (r) => r.includes('uncertain'),
      ),
    ).toBe(true);
  });

  test('unknown or terminal statuses never count as active', () => {
    for (const status of [null, 'SUCCESS', 'ERROR', 'CANCELLED', 'SOMETHING-NEW']) {
      const reasons = evaluateInflight({ ...evidence(), normalStatus: status, providerStatus: status });
      expect(reasons.length).toBeGreaterThan(0);
    }
    expect(ACTIVE_STATUSES).toEqual(['ENQUEUED', 'PENDING', 'RUNNING']);
  });

  test('normal workflow never started aborts', () => {
    const reasons = evaluateInflight({ ...evidence(), marks: [] });
    expect(reasons.some((r) => r.includes('no step-1 mark'))).toBe(true);
  });
});
