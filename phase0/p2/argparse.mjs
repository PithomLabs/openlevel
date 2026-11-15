/**
 * Strict CLI flag parsing for P2 operator commands (m1). Every --flag
 * requires a following non-flag value; bare flags, positional strays, and
 * unlisted flags all throw. Callers add their own required-flag and
 * value-allowlist checks on top of the returned record.
 */

/** Parse `--flag value` pairs strictly. Pure (throws on misuse). */
export function parseFlagPairs(argv, allowed) {
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const key = argv[i];
    if (!key || !key.startsWith('--')) {
      throw new Error(`usage error: expected --flag value, got "${key ?? '(missing)'}"`);
    }
    const name = key.slice(2);
    if (!allowed.includes(name)) {
      throw new Error(`usage error: unsupported flag --${name} (want ${allowed.map((a) => `--${a}`).join(', ') || '(none)'})`);
    }
    if (name in flags) {
      // Last-wins would let a duplicated value silently override the
      // operator's intent (i-R2); duplicates are always a mistake here.
      throw new Error(`usage error: duplicate flag --${name}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`usage error: --${name} requires a value`);
    }
    flags[name] = value;
    i += 2;
  }
  return flags;
}

/** Require a flag value from a parsed record. Pure (throws). */
export function needFlag(flags, name) {
  if (!flags[name]) throw new Error(`usage error: --${name} is required`);
  return flags[name];
}
