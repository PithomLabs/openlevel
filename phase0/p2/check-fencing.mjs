/**
 * Fencing transcript guard (M3). Validates a stop-verify-start replacement
 * transcript: the old worker Machine must be observed stopped BEFORE the
 * replacement executor starts, and the generation evidence must agree.
 * Pure validator plus a thin CLI; the transcript itself is captured by the
 * operator procedure (STAGING_ACCEPTANCE.md) — this guard refuses to bless
 * an ordering it cannot see.
 *
 * Clock discipline (m-R1): strict ordering comparisons use ONLY the
 * single-collector event sequence (one clock: the operator's watch).
 * Fly transition timestamps and DB generation timestamps are preserved
 * as supporting evidence but are NEVER compared across clocks, because
 * their skew is unestablished. In particular there is deliberately NO
 * check comparing replacement.startedAt (DB clock) against the Fly stop
 * timestamp — the event order (stop observed at seq 2, start requested
 * at seq 4) is the ordering proof.
 *
 * Transcript JSON shape:
 * {
 *   "oldMachine": { "id": "m-old",
 *     "transitions": [{ "state": "stopping", "at": "<iso>" },
 *                     { "state": "stopped", "at": "<iso>" }] },
 *   "replacement": { "bootId": "b-new", "machineId": "m-new",
 *     "executorId": "worker-1", "startedAt": "<iso>" },
 *   "generations": [ {boot_id, machine_id, executor_id, started_at_ms,
 *     last_heartbeat_ms, state, shutdown_at_ms} ],
 *   "events": [
 *     { "seq": 1, "name": "stop-requested", "at": "<iso>", "source": "operator",
 *       "machineId": "m-old" },
 *     { "seq": 2, "name": "machine-stopped", "at": "<iso>", "source": "fly machine status",
 *       "machineId": "m-old" },
 *     { "seq": 3, "name": "generation-inactive-verified", "at": "<iso>",
 *       "source": "generations query", "machineId": "m-old" },
 *     { "seq": 4, "name": "replacement-start-requested", "at": "<iso>",
 *       "source": "operator", "machineId": "m-new", "bootId": null },
 *     { "seq": 5, "name": "replacement-ready-observed", "at": "<iso>",
 *       "source": "generations query", "machineId": "m-new", "bootId": "b-new" }
 *   ]
 * }
 *
 * Usage: node phase0/p2/check-fencing.mjs --transcript <path>
 * Exit 0 when every check passes, 1 on any failure, 2 on misuse.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseFlagPairs, needFlag } from './argparse.mjs';
import { arbitrateReplacement } from './arbitrate.mjs';

const GENERATION_STALE_AFTER_MS = 3 * 60 * 1000;

function asMs(iso, what) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`malformed transcript: ${what} is not a valid timestamp`);
  return ms;
}

/**
 * Validate a parsed transcript. Returns one verdict row per check. Pure
 * (throws only on malformed input, which the CLI reports as a failure).
 */
export function validateFencingTranscript(t) {
  const verdicts = [];
  const push = (name, pass, detail) => verdicts.push({ name, pass, detail });
  if (!t || typeof t !== 'object') throw new Error('malformed transcript: top-level object required');
  const { oldMachine, replacement, generations } = t;
  if (!oldMachine || typeof oldMachine.id !== 'string' || !Array.isArray(oldMachine.transitions)) {
    throw new Error('malformed transcript: oldMachine.id + transitions[] required');
  }
  if (!replacement || typeof replacement.bootId !== 'string' || typeof replacement.startedAt !== 'string') {
    throw new Error('malformed transcript: replacement.bootId + startedAt required');
  }
  if (!Array.isArray(generations)) throw new Error('malformed transcript: generations[] required');
  const { events } = t;
  if (!Array.isArray(events)) throw new Error('malformed transcript: events[] required');

  // Event sequence (m-R1): the ONLY strict ordering source — one collector,
  // one clock. Canonical five events, exact seq 1..5, canonical names in
  // order, non-decreasing collector timestamps, consistent machine/boot IDs.
  const CANON = [
    'stop-requested',
    'machine-stopped',
    'generation-inactive-verified',
    'replacement-start-requested',
    'replacement-ready-observed',
  ];
  const eventProblems = [];
  if (events.length !== CANON.length) {
    eventProblems.push(`expected ${CANON.length} events, found ${events.length}`);
  }
  const byName = new Map();
  let prevAt = -Infinity;
  let monotonic = true;
  events.forEach((e, idx) => {
    if (!e || typeof e !== 'object') {
      eventProblems.push(`event ${idx}: not an object`);
      return;
    }
    if (e.seq !== idx + 1) eventProblems.push(`event ${idx}: seq ${JSON.stringify(e.seq)} breaks 1..5 order`);
    if (e.name !== CANON[idx]) eventProblems.push(`event ${idx}: name ${JSON.stringify(e.name)} breaks canonical order`);
    if (byName.has(e.name)) eventProblems.push(`duplicate event ${JSON.stringify(e.name)}`);
    byName.set(e.name, e);
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) eventProblems.push(`event ${idx}: invalid timestamp ${JSON.stringify(e.at)}`);
    else if (at < prevAt) monotonic = false;
    else prevAt = at;
    if (typeof e.source !== 'string' || e.source.length === 0) eventProblems.push(`event ${idx}: missing source`);
  });
  if (!monotonic) eventProblems.push('collector timestamps run backward (single clock must be non-decreasing)');
  const evMachine = (name) => byName.get(name)?.machineId;
  const evBoot = (name) => byName.get(name)?.bootId;
  if (evMachine('stop-requested') !== oldMachine.id) eventProblems.push('stop-requested machineId mismatch');
  if (evMachine('machine-stopped') !== oldMachine.id) eventProblems.push('machine-stopped machineId mismatch');
  if (evMachine('generation-inactive-verified') !== oldMachine.id) {
    eventProblems.push('generation-inactive-verified machineId mismatch');
  }
  if (evMachine('replacement-start-requested') !== replacement.machineId) {
    eventProblems.push('replacement-start-requested machineId mismatch');
  }
  if (evMachine('replacement-ready-observed') !== replacement.machineId) {
    eventProblems.push('replacement-ready-observed machineId mismatch');
  }
  if (evBoot('replacement-ready-observed') !== replacement.bootId) {
    eventProblems.push('replacement-ready-observed bootId mismatch');
  }
  push('event-sequence-valid', eventProblems.length === 0, eventProblems.length === 0 ? 'seq 1..5 canonical order, monotonic collector clock, ids consistent' : eventProblems.join('; '));

  const stopEntry = oldMachine.transitions.find((tr) => tr && (tr.state === 'stopped' || tr.state === 'destroyed'));
  push('old-machine-stopped-observed', stopEntry !== undefined, stopEntry ? `${stopEntry.state} at ${stopEntry.at}` : 'no stopped/destroyed transition recorded');
  push(
    'machine-evidence-agrees',
    byName.has('machine-stopped') && stopEntry !== undefined,
    'event claim requires a stopped/destroyed Fly transition and vice versa',
  );
  // Strict replacement ordering on the collector clock ONLY (never
  // DB-startedAt vs Fly-stoppedAt: unrelated clocks, unestablished skew).
  const stopObservedAt = byName.has('machine-stopped') ? Date.parse(byName.get('machine-stopped').at) : NaN;
  const startRequestedAt = byName.has('replacement-start-requested')
    ? Date.parse(byName.get('replacement-start-requested').at)
    : NaN;
  push(
    'replacement-after-stop',
    Number.isFinite(stopObservedAt) && Number.isFinite(startRequestedAt) && startRequestedAt > stopObservedAt,
    'replacement start requested strictly after stop observed (collector clock)',
  );

  // Generation agreement: no old generation may look alive at replacement
  // start. Fresh heartbeats past the replacement boot, or a missing
  // generation record for the old machine, fail closed. The replacement's
  // own boot is excluded: on a same-machine stop/start it shares the old
  // machine ID and must never be retired as an old generation (M3-R1).
  // Any OTHER fresh boot on that machine still fails below.
  // Retirement verdicts come from the SHARED arbitrateReplacement (m-R3),
  // evaluated at the replacement start instant (not wall clock: this is a
  // historical transcript). Machine states come from the transcript's Fly
  // transitions; unknown states stay undefined so the arbiter blocks.
  const replacementStart = asMs(replacement.startedAt, 'replacement.startedAt');
  const KNOWN_MACHINE_STATES = ['running', 'starting', 'stopping', 'stopped', 'destroyed'];
  const terminal = oldMachine.transitions.find((tr) => tr && (tr.state === 'stopped' || tr.state === 'destroyed'));
  const lastTransition = oldMachine.transitions.length > 0 ? oldMachine.transitions[oldMachine.transitions.length - 1] : null;
  const oldMachineState = terminal ? terminal.state : lastTransition && KNOWN_MACHINE_STATES.includes(lastTransition.state) ? lastTransition.state : undefined;
  const machines = oldMachineState === undefined ? {} : { [oldMachine.id]: oldMachineState };
  const olds = generations.filter((g) => g && g.machine_id === oldMachine.id && g.boot_id !== replacement.bootId);
  push('old-generation-recorded', olds.length > 0, `${olds.length} generation row(s) for ${oldMachine.id}`);
  for (const gen of olds) {
    if (!Number.isFinite(Number(gen.last_heartbeat_ms)) || typeof gen.state !== 'string') {
      push(`old-generation-retired:${gen.boot_id ?? '(unknown)'}`, false, 'unusable generation row (missing state/heartbeat)');
      continue;
    }
    const arbiter = arbitrateReplacement([gen], machines, replacementStart);
    push(`old-generation-retired:${gen.boot_id ?? '(unknown)'}`, arbiter.verdict === 'safe', arbiter.reason);
  }

  const repl = generations.find((g) => g && g.boot_id === replacement.bootId);
  push('replacement-generation-recorded', repl !== undefined, repl ? `state=${repl.state}` : 'missing generation row');
  if (repl) {
    push(
      'replacement-reached-ready',
      repl.state === 'ready' || repl.state === 'draining' || repl.state === 'stopped',
      `state=${repl.state}`,
    );
    push(
      'replacement-machine-consistent',
      repl.machine_id === replacement.machineId,
      `row machine=${repl.machine_id} vs transcript machine=${replacement.machineId}`,
    );
  }
  return verdicts;
}

async function main() {
  let file;
  try {
    file = needFlag(parseFlagPairs(process.argv.slice(2), ['transcript']), 'transcript');
  } catch (err) {
    console.error(`FATAL: ${err.message} (usage: check-fencing.mjs --transcript <path>)`);
    process.exit(2);
  }
  let verdicts;
  try {
    verdicts = validateFencingTranscript(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    console.error(`FENCING-FAIL transcript-rejected — ${err.message.slice(0, 300)}`);
    process.exit(1);
  }
  let failed = 0;
  for (const v of verdicts) {
    console.log(`${v.pass ? 'FENCING-OK  ' : 'FENCING-FAIL'} ${v.name} — ${v.detail}`);
    if (!v.pass) failed += 1;
  }
  if (failed > 0) {
    console.log(`fencing: FAIL (${failed}/${verdicts.length} checks failed)`);
    process.exit(1);
  }
  console.log('fencing: PASS (stop observed before replacement start, generations agree)');
}

const invokedAsScript = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  await main();
}
