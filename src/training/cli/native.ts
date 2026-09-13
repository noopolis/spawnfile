import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createCodexAdapter, createDaimonAdapter } from '../adapters/index.js';
import { snapshotCandidate, type ResourceMapping } from '../candidates/index.js';
import { createClaudeInference } from '../inference/index.js';
import { createEvaluationRegistry } from '../evaluation/index.js';
import { count, one, pairs, type CliArguments } from './arguments.js';
import { CliDatasets } from './datasets.js';
import type { CliDependencies, CliIO } from './types.js';

export function resourceMappings(args: CliArguments): ResourceMapping[] {
  const instructions = args.flags.instructions ?? [];
  if (!instructions.length) throw new Error('At least one --instructions Markdown file is required');
  const supporting = [...(args.flags.supporting ?? []), ...(args.flags.locked ?? [])];
  const declared = [...instructions, ...supporting];
  const editable = args.flags.editable ?? [];
  if (new Set(declared).size !== declared.length || new Set(editable).size !== editable.length) throw new Error('Resource selections must be unique');
  if (editable.some((path) => !declared.includes(path) || args.flags.locked?.includes(path))) throw new Error('--editable must select a declared, non-locked resource');
  return declared.map((path) => {
    if (!/\.(md|markdown)$/i.test(path)) throw new Error('The CLI maps Markdown files only; native project configuration requires its own integration');
    return { id: `resource-${createHash('sha256').update(path).digest('hex').slice(0, 16)}`, sourcePath: path,
      destinations: [{ kind: instructions.includes(path) ? 'instructions' as const : 'supporting-files' as const, path }],
      edit: editable.includes(path) ? 'whole-file' as const : 'locked' as const };
  });
}

export async function prepareNative(args: CliArguments, io: CliIO, dependencies: CliDependencies, timeoutMs: number) {
  const runtime = one(args, 'runtime');
  if (runtime !== 'codex' && runtime !== 'daimon') throw new Error('Supported native runtimes: codex, daimon');
  const model = one(args, 'model');
  const sourceRoot = resolve(io.cwd, one(args, 'source-root', io.cwd));
  const out = resolve(io.cwd, one(args, 'out'));
  const candidate = await snapshotCandidate({ sourceRoot, resources: resourceMappings(args) });
  const adapter = dependencies.adapter?.(runtime, { model, timeoutMs })
    ?? (runtime === 'codex' ? createCodexAdapter({ model, timeoutMs }) : createDaimonAdapter({ model, timeoutMs }));
  const judges = pairs(args.flags.judge ?? []);
  const inference = dependencies.inference?.(timeoutMs) ?? createClaudeInference({ timeoutMs });
  const datasets = new CliDatasets(judges, io.cwd);
  return { model, sourceRoot, out, candidate, adapter, inference, datasets,
    maxTrials: count(args, 'max-trials', 20, 10000),
    registry: createEvaluationRegistry(),
    evaluation: { judges: Object.fromEntries(Object.entries(judges).map(([name, model]) => [name, { provider: inference, model }])),
      embeddings: {}, readText: (path: string) => datasets.readCriterion(path) },
    resources: Object.fromEntries(Object.entries(pairs(args.flags.resource ?? [])).map(([name, path]) => [name, resolve(io.cwd, path)])),
  };
}
