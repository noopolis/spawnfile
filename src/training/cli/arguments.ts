import type { TrainingConfiguration } from '../contracts/training-config.js';
export interface CliArguments {
  command: 'help' | 'validate' | 'evaluate' | 'train' | 'view' | 'grader';
  graderCommand?: 'validate' | 'label' | 'calibrate' | 'grade' | 'expand' | 'decompose' | 'traps' | 'reference';
  dataset?: string;
  training?: TrainingConfiguration;
  frozenDataset?: { path: string; sourceDigest: string };
  flags: Readonly<Record<string, readonly string[]>>;
}

const repeated = new Set(['instructions', 'supporting', 'locked', 'editable', 'resource', 'judge', 'judge-citation-repairs', 'validation-group', 'exclude-dataset', 'context']);
const common = ['runtime', 'model', 'instructions', 'supporting', 'locked', 'resource', 'judge', 'judge-citation-repairs', 'source-root', 'out', 'max-trials', 'timeout-ms', 'view', 'cost-config', 'spawnfile-context'];
const graderFlags: Record<string, readonly string[]> = {
  decompose: ['templates', 'inputs', 'extractors', 'out', 'timeout-ms'],
  traps: ['allow-rejections', 'references', 'templates', 'decompositions', 'out', 'seed', 'timeout-ms'],
  reference: ['allow-rejections', 'templates', 'decompositions', 'traps', 'teachers', 'out', 'concurrency', 'batch-size', 'timeout-ms'],
  validate: ['grader', 'timeout-ms'],
  label: ['grader', 'import', 'inputs', 'teachers', 'relabel', 'adjudication', 'concurrency', 'limit', 'timeout-ms'],
  calibrate: ['max-spend-usd', 'grader', 'exclude-dataset', 'seed', 'report', 'concurrency', 'timeout-ms'],
  grade: ['max-spend-usd', 'grader', 'output', 'context', 'timeout-ms'],
  expand: ['grader', 'output', 'context', 'timeout-ms'],
};
const flags: Record<string, readonly string[]> = {
  validate: ['judge', 'judge-citation-repairs'], evaluate: common, view: ['port', 'timeout-ms'],
  train: [...common, 'concurrency', 'slots-file', 'train', 'test', 'editable', 'validation-group', 'optimizer-model', 'bridge-command', 'max-proposals', 'seed', 'dry-run', 'resume', 'repair-measurements', 'repair-context'],
};

export const helpText = `Paideia — explicit local native-agent experiments

grader decompose --templates FILE --inputs FILE --extractors codex[,claude] --out DIR [--timeout-ms N]
grader traps --templates FILE --decompositions DIR --out DIR [--references FILE] [--allow-rejections] [--seed S] [--timeout-ms N]
grader reference --templates FILE --decompositions DIR [--traps DIR] [--allow-rejections] --teachers codex,claude[,grok] --out FILE [--concurrency N] [--timeout-ms N]
grader validate --grader FILE [--timeout-ms N]
grader label --grader FILE --inputs FILE --teachers a,b [--relabel] [--adjudication N] [--concurrency N] [--limit N] [--timeout-ms N]
grader label --grader FILE --import FILE [--relabel] [--timeout-ms N]
grader calibrate --grader FILE [--max-spend-usd N] [--exclude-dataset FILE]... [--seed S] [--report FILE.md] [--concurrency N] [--timeout-ms N]
grader grade --grader FILE [--max-spend-usd N] --output FILE.json [--context NAME=FILE]... [--timeout-ms N]
grader expand --grader FILE --output FILE.json [--context NAME=FILE]... [--timeout-ms N]
validate DATASET [--judge NAME=MODEL]
view OUT_DIRECTORY [--port PORT] [--timeout-ms N]
evaluate DATASET --runtime codex|daimon --model MODEL --instructions FILE --out DIRECTORY
train --train DATASET [--test DATASET] --runtime codex|daimon --model MODEL
      --instructions FILE --editable FILE --optimizer-model MODEL --bridge-command EXECUTABLE --out DIRECTORY

Repeat --instructions FILE, --supporting FILE or --locked FILE to select Markdown resources.
All resources are locked by default; train --editable selects a declared whole file.
Source paths and native destinations are identical, relative to --source-root (default cwd).
Native skills, Spawnfile compilation and custom setup recipes require a public API integration.
Repeat --resource NAME=DIRECTORY for hash-pinned dataset inputs; --judge NAME=MODEL uses Claude subscriptions.
--judge-citation-repairs NAME=0|1 selects one optional citation repair for a declared judge (default 0).
This never retries valid quality failures, authentication/quota failures or malformed JSON.
Dataset training controls declare named models, focused judges, fallbacks, templates, cache, optimizer, test and budgets.
YAML test paths are relative to the training dataset; scalar CLI flags override authored defaults.
Configured judge policies cannot be replaced by --judge or conflicting citation repair flags.
The optimizer bridge defaults to the installed paideia-dspy executable for YAML-configured training.
Train accepts repeated --validation-group GROUP, or freezes an internal group partition.
--max-trials N (default 20, ceiling 10000) includes conservative reserved sealed-test trials.
--concurrency N (1..8; defaults to provisioned slot count, otherwise 1); --slots-file FILE overrides /run/paideia/slots.json.
--max-proposals N (default 3, ceiling 1000), --seed N (GEPA sampling only).
train --dry-run resolves local inputs and prints an API-equivalent cost plan without launching any runtime or model.
train --resume reopens the same --out with unchanged execution inputs and cumulative optimizer budgets.
train --repair-measurements PARENT --out FRESH forks verified development evidence using a launcher-produced --repair-context receipt.
Repair preserves valid grades and native work; its dry-run conservatively estimates a full run without importing evidence.
--cost-config FILE selects a paideia.cost-config.v1 YAML with token assumptions and explicit model prices.
Dry-run requires no --out or --bridge-command. Unknown costs are reported, never priced at zero.
--timeout-ms N (default 180000 for evaluate/train/grader, ceiling 3600000) is the whole-command deadline.
Output stays local. An invocation index identifies immutable stored report and candidate blobs.
--view PORT enables persisted live observation during evaluate/train (0 selects a free port).
view reads a saved invocation with its recorded frozen-candidate authorization and has no default deadline.
Ctrl+C closes the server; view --timeout-ms N adds an explicit deadline.
Exit: 0 completed/passing, 1 completed with failed checks, 2 error, 130 cancelled.
`;

export function parseArguments(argv: readonly string[]): CliArguments {
  if (argv.length === 0 || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]!))) return { command: 'help', flags: {} };
  const command = argv[0]!;
  const graderCommand = command === 'grader' ? argv[1] : undefined;
  const allowed = command === 'grader' ? graderFlags[graderCommand ?? ''] : flags[command];
  if (!allowed) throw new Error(`Unsupported command ${command}; use --help`);
  const values: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let index = command === 'grader' ? 2 : 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('-')) { positional.push(token); continue; }
    const name = token.slice(2);
    if (!token.startsWith('--') || !allowed.includes(name)) throw new Error(`Unsupported option ${token} for ${command}`);
    if (name === 'dry-run' || name === 'resume' || name === 'relabel' || name === 'allow-rejections') {
      if (values[name]) throw new Error(`Option ${token} may appear only once`);
      values[name] = ['true'];
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.length === 0 || value.startsWith('-')) throw new Error(`Option ${token} requires a value`);
    if (values[name] && !repeated.has(name)) throw new Error(`Option ${token} may appear only once`);
    (values[name] ??= []).push(value);
  }
  if (command === 'grader') {
    if (positional.length) throw new Error('grader accepts flags only');
    if (values.import && (values.inputs || values.teachers)) throw new Error('--import is mutually exclusive with --inputs/--teachers');
    if (values.import && (values.adjudication || values.concurrency || values.limit)) throw new Error('--import does not accept --adjudication/--concurrency/--limit');
    const atomicRequired: Record<string, string[]> = {
      decompose: ['templates', 'inputs', 'extractors', 'out'],
      traps: ['templates', 'decompositions', 'out'],
      reference: ['templates', 'decompositions', 'teachers', 'out'],
    };
    for (const required of atomicRequired[graderCommand ?? ''] ?? (graderCommand === 'label' && !values.import ? ['grader', 'inputs', 'teachers'] : graderCommand === 'grade' || graderCommand === 'expand' ? ['grader', 'output'] : ['grader'])) {
      if (!values[required]) throw new Error(`Required option --${required} is missing`);
    }
    if (values['max-spend-usd'] && (!values['max-spend-usd'][0]!.trim() || !Number.isFinite(Number(values['max-spend-usd'][0])) || Number(values['max-spend-usd'][0]) < 0)) throw new Error('--max-spend-usd must be a finite nonnegative number');
    return { command: 'grader', graderCommand: graderCommand as CliArguments['graderCommand'], flags: values };
  }
  if (positional.length !== (command === 'train' ? 0 : 1)) throw new Error(`${command} requires ${command === 'train' ? '--train and --test, without positional arguments' : 'exactly one dataset path'}`);
  const args = { command: command as CliArguments['command'], dataset: positional[0], flags: values };
  if (Boolean(values['repair-context']) !== Boolean(values['repair-measurements']) && !values['dry-run']) {
    throw new Error('Measurement repair requires both a parent and a protected launcher receipt');
  }
  judgeCitationRepairs(args);
  return args;
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

export function judgeCitationRepairs(args: CliArguments, judges = pairs(args.flags.judge ?? [])): Record<string, 0 | 1> {
  const selections = pairs(args.flags['judge-citation-repairs'] ?? []);
  for (const [name, value] of Object.entries(selections)) {
    if (!Object.hasOwn(judges, name)) throw new Error(`--judge-citation-repairs names unknown judge ${name}`);
    if (value !== '0' && value !== '1') throw new Error('--judge-citation-repairs requires literal NAME=0 or NAME=1');
  }
  return Object.fromEntries(Object.keys(judges).map(name => [name, selections[name] === '1' ? 1 : 0]));
}
