export interface CliArguments {
  command: 'help' | 'validate' | 'evaluate' | 'train' | 'view';
  dataset?: string;
  flags: Readonly<Record<string, readonly string[]>>;
}

const repeated = new Set(['instructions', 'supporting', 'locked', 'editable', 'resource', 'judge', 'validation-group']);
const common = ['runtime', 'model', 'instructions', 'supporting', 'locked', 'resource', 'judge', 'source-root', 'out', 'max-trials', 'timeout-ms', 'view', 'cost-config', 'spawnfile-context'];
const flags: Record<string, readonly string[]> = {
  validate: ['judge'], evaluate: common, view: ['port', 'timeout-ms'],
  train: [...common, 'train', 'test', 'editable', 'validation-group', 'optimizer-model', 'bridge-command', 'max-proposals', 'seed', 'dry-run'],
};

export const helpText = `Paideia — explicit local native-agent experiments

validate DATASET [--judge NAME=MODEL]
view OUT_DIRECTORY [--port PORT] [--timeout-ms N]
evaluate DATASET --runtime codex|daimon --model MODEL --instructions FILE --out DIRECTORY
train --train DATASET --test DATASET --runtime codex|daimon --model MODEL
      --instructions FILE --editable FILE --optimizer-model MODEL --bridge-command EXECUTABLE --out DIRECTORY

Repeat --instructions FILE, --supporting FILE or --locked FILE to select Markdown resources.
All resources are locked by default; train --editable selects a declared whole file.
Source paths and native destinations are identical, relative to --source-root (default cwd).
Native skills, Spawnfile compilation and custom setup recipes require a public API integration.
Repeat --resource NAME=DIRECTORY for hash-pinned dataset inputs; --judge NAME=MODEL uses Claude subscriptions.
Train accepts repeated --validation-group GROUP, or freezes an internal group partition.
--max-trials N (default 20, ceiling 10000) includes conservative reserved sealed-test trials.
--max-proposals N (default 3, ceiling 1000), --seed N (GEPA sampling only).
train --dry-run resolves local inputs and prints an API-equivalent cost plan without launching any runtime or model.
--cost-config FILE selects a paideia.cost-config.v1 YAML with token assumptions and explicit model prices.
Dry-run requires no --out or --bridge-command. Unknown costs are reported, never priced at zero.
--timeout-ms N (default 180000, ceiling 3600000) is the whole-command deadline.
Output stays local. An invocation index identifies immutable stored report and candidate blobs.
--view PORT enables persisted live observation during evaluate/train (0 selects a free port).
view reads a completed invocation with its recorded frozen-candidate authorization; Ctrl+C closes the server.
Exit: 0 completed/passing, 1 completed with failed checks, 2 error, 130 cancelled.
`;

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]!))) return { command: 'help', flags: {} };
  const command = argv[0]!;
  const allowed = flags[command];
  if (!allowed) throw new Error(`Unsupported command ${command}; use --help`);
  const values: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const name = token.slice(2);
    if (!token.startsWith('--') || !allowed.includes(name)) throw new Error(`Unsupported option ${token} for ${command}`);
    if (name === 'dry-run') {
      if (values[name]) throw new Error(`Option ${token} may appear only once`);
      values[name] = ['true'];
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('-')) throw new Error(`Option ${token} requires a value`);
    if (values[name] && !repeated.has(name)) throw new Error(`Option ${token} may appear only once`);
    (values[name] ??= []).push(value);
  }
  if (positional.length !== (command === 'train' ? 0 : 1)) throw new Error(`${command} requires ${command === 'train' ? '--train and --test, without positional arguments' : 'exactly one dataset path'}`);
  return { command: command as CliArguments['command'], dataset: positional[0], flags: values };
}

export function one(args: CliArguments, name: string, fallback?: string): string {
  const value = args.flags[name]?.[0] ?? fallback;
  if (value === undefined || value.trim().length === 0) throw new Error(`Required option --${name} is missing`);
  return value;
}

export function count(args: CliArguments, name: string, fallback: number, maximum: number, minimum = 1): number {
  const text = one(args, name, String(fallback));
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function pairs(values: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    const split = value.indexOf('=');
    const name = value.slice(0, split), target = value.slice(split + 1);
    if (split < 1 || !/^[A-Za-z][\w.-]{0,119}$/.test(name) || !target.trim() || Object.hasOwn(result, name)) {
      throw new Error('Mappings require unique NAME=VALUE entries');
    }
    result[name] = target;
  }
  return result;
}
