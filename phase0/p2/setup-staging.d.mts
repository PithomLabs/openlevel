/** Types for the sibling setup-staging.mjs (kept dependency-free for the staging image). */
export function assertValidRoleName(appRole: string): void;
export function splitSqlStatements(sql: string): string[];
export function parseStagingUrl(url: string, label: string): { host: string; db: string; sslmode: string };
export function stagingGrants(appRole: string): string[];
export function connectGrant(appRole: string, dbName: string): string;
export function createRoleStatement(appRole: string): string;
export function redactUrl(url: string): string;
export function applyStagingSetup(args: {
  sysUrl: string;
  appUrl: string;
  dbName: string;
  appRole: string | null;
  sysPool?: unknown;
  appPool?: unknown;
}): Promise<{ sysVersion: string; appVersion: string; tables: string[] }>;
