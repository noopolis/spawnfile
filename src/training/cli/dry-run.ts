import { configuredCostRoutes, prepareComparison, editableResources, populationSearch } from './training/index.js';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { candidateComponents } from '../candidates/index.js';
import { planTrainingCost, resolveCostConfig } from '../experiments/index.js';
import { count, one, type CliArguments } from './arguments.js';
import { readCliText } from './datasets.js';
import { prepareInputs } from './native.js';
import type { CliDependencies, CliIO } from './types.js';
import { prepareSpawnfileInputs } from './spawnfile/index.js';

export function readCostConfig(args: CliArguments, io: CliIO) {
  const file = args.flags['cost-config']?.[0];
  if (file === undefined) return resolveCostConfig();
  const document = parseDocument(readCliText(resolve(io.cwd, file), 1_000_000), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid cost configuration: ${document.errors[0]!.message}`);
  return resolveCostConfig(document.toJS({ maxAliasCount: 50 }));
}

export async function dryRunTraining(args: CliArguments, io: CliIO, dependencies: CliDependencies = {}): Promise<number> {
  const native = args.flags['spawnfile-context'] ? await prepareSpawnfileInputs(args, io, dependencies.spawnfile) : await prepareInputs(args, io, dependencies.spawnfile?.inferenceExecutionIdentity);
  const train = native.datasets.loadForCost(one(args, 'train'), true);
  const test = native.datasets.loadForCost(one(args, 'test'), true);
  if (!candidateComponents(native.candidate).length) throw new Error('No declared editable components');
  const comparison = prepareComparison(args, io, native.candidate);
  const plan = planTrainingCost({ train, test, validationGroups: args.flags['validation-group'],
    subjectModel: native.model, ...(comparison ? { mode: 'comparison' as const } : { optimizerModel: one(args, 'optimizer-model') }),
    ...configuredCostRoutes(args, native.judges, native.citationRepairs),
    maxTrials: native.maxTrials, maxProposals: comparison ? 0 : count(args, 'max-proposals', 3, 1000), ...readCostConfig(args, io) });
  io.stdout(`${JSON.stringify({ ...plan, candidateId: native.candidate.id, editableResources: editableResources(native.candidate),
    ...(populationSearch(args.training?.optimizer) ? { search: populationSearch(args.training?.optimizer) } : {}), ...(comparison ? { comparison: { name: comparison.name, candidateId: comparison.candidate.id, optimizerCalls: 0 } } : {}),
    ...('context' in native ? { spawnfile: native.context, readiness: native.readiness } : {}) })}\n`);
  return 0;
}
