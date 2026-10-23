import type { InferenceProviderRegistry } from '../contracts/index.js';
import { judgeVersions, createTrainingInference, prepareJudgeCaches } from './training/index.js';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { resolveSubjectAdapter } from '../subjects/index.js';
import { snapshotCandidate, type ResourceMapping } from '../candidates/index.js';
import { createEvaluationRegistry } from '../evaluation/index.js';
import { count, judgeCitationRepairs, one, pairs, type CliArguments } from './arguments.js';
import { CliDatasets } from './datasets.js';
import type { CliDependencies, CliIO } from './types.js';
import { spawnfileEnvironment } from './spawnfile/index.js';
import { prepareSpawnfileInputs } from './spawnfile/index.js';
import type { StoredTrialOptions } from '../experiments/index.js';

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

/** File selection only; deliberately has no runtime or inference construction. */
export async function prepareInputs(args: CliArguments, io: CliIO, executionIdentity?: string, subjects?: CliDependencies['subjects'], inferenceProviders?: InferenceProviderRegistry) {
  const runtime = one(args, 'runtime');
  if (!runtime || !subjects || !Object.hasOwn(subjects, runtime)) throw new Error(`Supported native runtimes: ${Object.keys(subjects ?? {}).join(', ') || 'none registered'}`);
  const model = one(args, 'model');
  const sourceRoot = resolve(io.cwd, one(args, 'source-root', io.cwd));
  const out = resolve(io.cwd, one(args, 'out', args.flags['dry-run'] ? '.runtime/training' : undefined));
  const candidate = await snapshotCandidate({ sourceRoot, resources: resourceMappings(args) });
  const judges = pairs(args.flags.judge ?? []);
  const datasets = new CliDatasets(judges, io.cwd, { inferenceExecutionIdentity: executionIdentity, inferenceProviders }, judgeVersions(args.training, executionIdentity, Object.keys(judges), inferenceProviders), args.frozenDataset);
  return { context: undefined, readiness: undefined, runtime, model, sourceRoot, out, candidate, judges, datasets,
    citationRepairs: judgeCitationRepairs(args, judges),
    maxTrials: count(args, 'max-trials', 20, 10000),
    resources: Object.fromEntries(Object.entries(pairs(args.flags.resource ?? [])).map(([name, path]) => [name, resolve(io.cwd, path)])),
  };
}

export async function prepareCliInputs(args: CliArguments, io: CliIO, dependencies: CliDependencies) {
  return args.flags['spawnfile-context'] || dependencies.spawnfileContext !== undefined
    ? await prepareSpawnfileInputs(args, io, dependencies.spawnfile, dependencies.spawnfileContext, dependencies.inferenceProviders) : await prepareInputs(args, io, dependencies.spawnfile?.inferenceExecutionIdentity, dependencies.subjects, dependencies.inferenceProviders);
}

export async function prepareNative(args: CliArguments, io: CliIO, dependencies: CliDependencies, timeoutMs: number,
  prepared?: Awaited<ReturnType<typeof prepareCliInputs>>, inferenceTimeoutMs = timeoutMs) {
  const inputs = prepared ?? await prepareCliInputs(args, io, dependencies);
  const { runtime, model, judges, datasets } = inputs;
  const graders = await datasets.buildGraders(dependencies.grader, args.command === 'train');
  // Native services are created once per experiment in its durable output state.
  const services = inputs.context !== undefined ? (dependencies.createTrialServices?.(inputs.out) ?? {}) : undefined;
  const adapter = inputs.context !== undefined
    ? dependencies.spawnfile!.createAdapter(inputs.context, { model, timeoutMs, ...services })
    : dependencies.adapter?.(runtime, { model, timeoutMs })
      ?? resolveSubjectAdapter(dependencies.subjects, runtime, { model, timeoutMs });
  const configured = createTrainingInference(args, dependencies, inferenceTimeoutMs, judges, inputs.citationRepairs);
  let cacheRoots: Awaited<ReturnType<typeof prepareJudgeCaches>>;
  try { cacheRoots = await prepareJudgeCaches(args, configured.judges, inputs.out, dependencies.spawnfile?.judgeCacheRoot); }
  catch (error) { await configured.close(); throw error; }
  const inference = args.training?.comparison ? undefined : configured.inference;
  let prepareEnvironment: StoredTrialOptions['prepareEnvironment'];
  if (inputs.context !== undefined) {
    const context = inputs.context;
    prepareEnvironment = spawnfileEnvironment(dependencies.spawnfile!, context, services!);
  }
  const subjectRoot = inputs.context !== undefined ? dependencies.spawnfile!.subjectRoot : undefined;
  return { ...inputs, adapter, inference, prepareEnvironment, cacheRoots, subjectRoot, closeInference: configured.close,
    registry: createEvaluationRegistry(),
    evaluation: { judges: configured.judges, graders,
      embeddings: {}, readText: (path: string) => datasets.readCriterion(path) },
  };
}
