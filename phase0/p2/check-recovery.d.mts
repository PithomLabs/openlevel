/** Types for the sibling check-recovery.mjs (operator command, plain node). */
export function parseArgs(argv: string[]): { op: string; tag: string; expectRecovery: boolean };
export function runRecoveryChecks(
  pool: { query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> },
  spec: { op: string; tag: string; expectRecovery: boolean },
): Promise<Array<{ name: string; pass: boolean; detail: string }>>;
