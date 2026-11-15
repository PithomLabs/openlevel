/** Types for the sibling check-inflight.mjs (T2 precondition gate, plain node). */
export const ACTIVE_STATUSES: string[];
export function parseArgs(argv: string[]): { tag: string };
export function evaluateInflight(evidence: {
  marks: string[];
  providerOp: { attempts: Array<{ attempt_id: string; state: string }>; ledgerCount: number };
  uncertainOp: { attempts: Array<{ attempt_id: string; state: string }> };
  normalStatus: string | null;
  providerStatus: string | null;
}): string[];
