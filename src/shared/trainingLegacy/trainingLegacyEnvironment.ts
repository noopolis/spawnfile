/** Read legacy deployment inputs without emitting their names into child environments. */
const legacyPrefix = 'PAIDEIA_';
const trainingPrefix = 'SPAWNFILE_TRAINING_';
let warned = false;

function warn(): void {
  if (warned) return;
  warned = true;
  process.stderr.write('Deprecated legacy training environment variables; use SPAWNFILE_TRAINING_* names.\n');
}

function currentName(legacy: string): string {
  return legacy === `${legacyPrefix}TRAINING_SLOTS_FILE` ? `${trainingPrefix}SLOTS_FILE`
    : `${trainingPrefix}${legacy.slice(legacyPrefix.length)}`;
}

/** An explicitly empty current value also overrides the legacy value. */
export function trainingEnvironment(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const legacy = name === `${trainingPrefix}SLOTS_FILE` ? `${legacyPrefix}TRAINING_SLOTS_FILE`
    : `${legacyPrefix}${name.slice(trainingPrefix.length)}`;
  if (env[legacy] !== undefined) warn();
  return env[name] ?? env[legacy];
}

/** Child processes receive current names only, with current values taking precedence. */
export function normalizedTrainingEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const normalized = { ...env };
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(legacyPrefix)) continue;
    delete normalized[name];
    if (value === undefined) continue;
    warn();
    const current = currentName(name);
    normalized[current] ??= value;
  }
  return normalized;
}
