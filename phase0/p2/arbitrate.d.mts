/** Types for the sibling arbitrate.mjs (shared replacement arbitration). */
export const GENERATION_STALE_AFTER_MS: number;
export function arbitrateReplacement(
  oldGenerations: Array<{ boot_id: string; machine_id: string; state: string; last_heartbeat_ms: number }>,
  machines: Map<string, string> | Record<string, string>,
  nowMs: number,
): { verdict: 'safe' | 'blocked'; reason: string };
