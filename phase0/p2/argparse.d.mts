/** Types for the sibling argparse.mjs (strict operator CLI parsing). */
export function parseFlagPairs(argv: string[], allowed: string[]): Record<string, string>;
export function needFlag(flags: Record<string, string>, name: string): string;
