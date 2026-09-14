import { validateJudgeTemplate } from '../../evaluation/index.js';
import { dirname, resolve } from 'node:path';
import { parseDatasetYaml, trainingJudgeVersions } from '../../cases/index.js';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { one, pairs, type CliArguments } from '../arguments.js';
import { readCliText } from '../datasets.js';
import type { CliIO } from '../types.js';

/** Resolve authored controls before the command-wide timer or any native factory. */
export function authoredArguments(args: CliArguments, io: CliIO): CliArguments {
  if (!['train', 'evaluate', 'validate'].includes(args.command)) return args;
  const file = args.command === 'train' ? one(args, 'train') : args.dataset!;
  const path = resolve(io.cwd, file);
  const document = parseDatasetYaml(readCliText(path, 2_000_000), { sourceName: path });
  const frozenDataset = { path, sourceDigest: document.sourceDigest };
  const training = document.dataset.training;
  if (!training) return { ...args, frozenDataset };
  const flags: Record<string, readonly string[]> = { ...args.flags };
  function fallback(name: string, value: string | number | undefined): void {
    if (flags[name] === undefined && value !== undefined) flags[name] = [String(value)];
  }
  if (args.command === 'train') {
    fallback('test', training.test === undefined ? undefined : resolve(dirname(path), training.test));
    fallback('max-trials', training.budget?.max_trials);
    fallback('max-proposals', training.budget?.max_proposals);
    fallback('timeout-ms', training.budget?.timeout_ms);
    fallback('seed', training.seed);
    if (training.optimizer && flags['optimizer-model'] && flags['optimizer-model'][0] !== training.models[training.optimizer.model]!.model) {
      throw new Error('Configured YAML optimizer conflicts with --optimizer-model');
    }
    fallback('optimizer-model', training.optimizer === undefined ? undefined : training.models[training.optimizer.model]!.model);
    fallback('bridge-command', 'paideia-dspy');
    if (flags['validation-group'] === undefined && training.validation_groups !== undefined) flags['validation-group'] = training.validation_groups;
  }
  const explicit = pairs(flags.judge ?? []);
  for (const name of Object.keys(training.judges ?? {})) {
    if (Object.hasOwn(explicit, name)) throw new Error(`Judge ${name} is configured in YAML; remove its conflicting --judge override`);
  }
  flags.judge = [...(flags.judge ?? []), ...Object.entries(training.judges ?? {}).map(([name, route]) => `${name}=${training.models[route.model]!.model}`)];
  const repairs = pairs(flags['judge-citation-repairs'] ?? []);
  for (const name of Object.keys(training.judges ?? {})) {
    if (Object.hasOwn(repairs, name) && repairs[name] !== String(training.judges![name]!.citation_repairs ?? 0)) {
      throw new Error(`Judge ${name} citation repair policy conflicts with YAML`);
    }
  }
  flags['judge-citation-repairs'] = [...(flags['judge-citation-repairs'] ?? []), ...Object.entries(training.judges ?? {})
    .filter(([name]) => !Object.hasOwn(repairs, name)).map(([name, route]) => `${name}=${route.citation_repairs ?? 0}`)];
  return { ...args, flags, training, frozenDataset };
}

export function judgeVersions(training?: TrainingConfiguration) {
  return training === undefined ? {} : trainingJudgeVersions(training);
}

export async function validateAuthoredTemplates(args: CliArguments, signal?: AbortSignal): Promise<void> {
  for (const policy of Object.values(args.training?.judges ?? {})) {
    if (policy.template) await validateJudgeTemplate(policy.template, signal);
  }
}
