/**
 * Shared replacement arbitration (m-R3). ONE implementation of the
 * three-state rule, imported by both the TypeScript generations module
 * (unit-tested decision logic) and the plain-node fencing guard
 * (transcript validation) — no duplicated arbitration that can drift.
 *
 * Rule: freshness alone can never retire a worker. Only authoritative
 * stopped-machine evidence retires a generation; missing or
 * contradictory evidence blocks the replacement (fail closed).
 */

export const GENERATION_STALE_AFTER_MS = 3 * 60 * 1000;

/**
 * @param {Array<{boot_id: string, machine_id: string, state: string, last_heartbeat_ms: number}>} oldGenerations
 * @param {Map<string, string> | Record<string, string>} machines machine_id → latest known state
 * @param {number} nowMs reference instant (wall clock for live checks,
 *   replacement-start instant for historical transcripts)
 * @returns {{verdict: 'safe' | 'blocked', reason: string}}
 */
export function arbitrateReplacement(oldGenerations, machines, nowMs) {
  const states = machines instanceof Map ? machines : new Map(Object.entries(machines));
  if (oldGenerations.length === 0) {
    return { verdict: 'blocked', reason: 'no prior generation evidence: refusing blind replacement' };
  }
  for (const gen of oldGenerations) {
    const machine = states.get(gen.machine_id);
    if (machine === undefined) {
      return { verdict: 'blocked', reason: `machine ${gen.machine_id} state unavailable: indeterminate, replacement blocked` };
    }
    if (machine === 'running' || machine === 'starting' || machine === 'stopping') {
      return { verdict: 'blocked', reason: `machine ${gen.machine_id} is ${machine}: worker potentially active` };
    }
    const fresh = nowMs - gen.last_heartbeat_ms <= GENERATION_STALE_AFTER_MS;
    if (fresh && gen.state !== 'stopped') {
      return {
        verdict: 'blocked',
        reason: `machine ${gen.machine_id} reports ${machine} but generation ${gen.boot_id} has a fresh heartbeat: contradictory evidence, replacement blocked`,
      };
    }
  }
  return { verdict: 'safe', reason: 'all prior generations retired on stopped machines with consistent evidence' };
}
