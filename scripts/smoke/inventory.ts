/**
 * The ONE authoritative smoke-probe inventory (R14-05 + approval refinement
 * #5). Three requirement lists — R14-05's 12 Docker claims, prompt43's
 * 16-point staging smoke, and its 12-point production-preview smoke —
 * reconcile into this single probe set. The same probes run against local
 * Docker, staging, and production preview; each probe declares its targets
 * and environment-appropriate expectations, and reports PASS / FAIL /
 * NOT RUN (never a pass by inspection).
 *
 * Source tags: D01..D12 = R14-05 Docker claims (§5), S01..S16 = staging
 * smoke (§8), P01..P12 = production-preview smoke (§9). The inventory test
 * (`smoke.test.ts`) proves every source item maps to at least one probe.
 */

export type SmokeTarget = 'local' | 'staging' | 'preview'

export interface ProbeSpec {
  /** Stable id, used in transcripts. */
  id: string
  /** One-line behavior statement. */
  name: string
  /** Targets this probe executes against (others report NOT RUN). */
  targets: SmokeTarget[]
  /** Requirement sources this probe evidences. */
  sources: string[]
}

export const PROBES: ProbeSpec[] = [
  { id: 'endpoint', name: 'Base URL reachable over the expected scheme', targets: ['local', 'staging', 'preview'], sources: ['S01', 'P05'] },
  { id: 'health', name: 'GET /health returns ok', targets: ['local', 'staging', 'preview'], sources: ['D03', 'S02', 'P04'] },
  { id: 'ready', name: 'GET /ready returns ready (migrated + workers up)', targets: ['local', 'staging', 'preview'], sources: ['D03', 'S02', 'P04'] },
  { id: 'static-frontend', name: 'Static SPA delivery with app marker', targets: ['local', 'staging', 'preview'], sources: ['D04', 'S03'] },
  { id: 'preview-banner', name: 'Restricted-preview banner present iff preview', targets: ['local', 'staging', 'preview'], sources: ['P07'] },
  { id: 'boot-identity', name: 'Boot log binds env identity + release', targets: ['local', 'staging', 'preview'], sources: ['D01', 'P01'] },
  { id: 'migration-version', name: 'Schema migrations applied; version readable', targets: ['local', 'staging', 'preview'], sources: ['D02', 'P02', 'P03'] },
  { id: 'auth', name: 'Login works; wrong creds 401; anonymous operator routes 401', targets: ['local', 'staging', 'preview'], sources: ['S04', 'P06'] },
  { id: 'lead-capture', name: 'Publish form via API, capture lead via public submit', targets: ['local', 'staging', 'preview'], sources: ['S05', 'P08'] },
  { id: 'submission-identity', name: 'R14-01 semantics live: keyless distinct, keyed replay, clash 409', targets: ['local', 'staging', 'preview'], sources: ['S06'] },
  { id: 'contact-identity', name: 'Repeat capture resolves same contact; conflicts 409', targets: ['local', 'staging', 'preview'], sources: ['S07'] },
  { id: 'booking', name: 'Slots + book + keyed replay + rival 409', targets: ['local', 'staging', 'preview'], sources: ['D05', 'S08'] },
  { id: 'confirm-idempotency', name: 'Double assistant confirm writes once', targets: ['local', 'staging', 'preview'], sources: ['S09'] },
  { id: 'campaign-lifecycle', name: 'Campaign create + send + cancel; send simulated (staging) / refused (preview)', targets: ['local', 'staging', 'preview'], sources: ['S10', 'P09'] },
  { id: 'outbox-drain', name: 'Outbox drains; DLQ depth zero after journey', targets: ['local', 'staging', 'preview'], sources: ['D09', 'S11'] },
  { id: 'reporting', name: 'Reporting endpoint honest about simulated outcomes', targets: ['local', 'staging', 'preview'], sources: ['S12', 'P10'] },
  { id: 'federation', name: 'Federation gate: 401/503 without valid bearer', targets: ['local', 'staging', 'preview'], sources: ['S13'] },
  { id: 'voice-sink', name: 'Voice placement sinks (staging) / refuses (preview)', targets: ['local', 'staging', 'preview'], sources: ['D06', 'S14', 'P09'] },
  { id: 'sms-sink', name: 'Operator send_text sinks (staging) / refuses (preview)', targets: ['local', 'staging', 'preview'], sources: ['S14', 'P09'] },
  { id: 'chatwoot-inbound', name: 'Unsigned/wrong-secret inbound rejected; valid accepted', targets: ['local', 'staging', 'preview'], sources: ['D07'] },
  { id: 'push-suppression', name: 'Inbound triggers observable push suppression', targets: ['local', 'staging', 'preview'], sources: ['D08', 'S14', 'P09'] },
  { id: 'sigterm', name: 'Graceful SIGTERM shutdown (local: live stop; remote: prior-stop log evidence)', targets: ['local', 'staging', 'preview'], sources: ['D10', 'S16'] },
  { id: 'credential-scan', name: 'Zero credential patterns in captured logs + transcript', targets: ['local', 'staging', 'preview'], sources: ['D11'] },
  { id: 'provider-config-absence', name: 'No provider URLs/credentials in container env (adapters cannot construct)', targets: ['local'], sources: ['D12'] },
  { id: 'provider-non-invocation', name: 'Every send outcome simulated/refused; zero live provider contact', targets: ['local', 'staging', 'preview'], sources: ['D12', 'S15', 'P12'] },
  { id: 'no-staging-reuse', name: 'Preview uses its own DB/app identity (no staging reuse)', targets: ['preview'], sources: ['P11'] },
  { id: 'digest-proof', name: 'Running image digest recorded (staging == preview)', targets: ['local', 'staging', 'preview'], sources: ['S-record', 'P-record'] },
  { id: 'cleanup', name: 'Smoke fixtures removed; zero smoke rows remain', targets: ['local', 'staging', 'preview'], sources: ['S-fixtures', 'P-fixtures'] },
]

/** The three prompt43 requirement lists, as citable source ids. */
export const SOURCES = {
  docker: ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09', 'D10', 'D11', 'D12'],
  staging: ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S-record', 'S-fixtures'],
  preview: ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12', 'P-record', 'P-fixtures'],
}
