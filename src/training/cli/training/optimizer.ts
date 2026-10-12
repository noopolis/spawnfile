import { validateTrainingConfiguration } from '../../cases/index.js';
import { type CandidateManifest } from '../../candidates/index.js';
import type { TrainingOptimizer } from '../../contracts/training-config.js';
import type { CliArguments } from '../arguments.js';
import { count } from '../arguments.js';
import type { SpawnfileCliIntegration } from '../types.js';
import type { SpawnfileTrainingContext } from '../spawnfile/index.js';

/** Merge only equal declarations, resolving a public model name to its explicit route. */
export async function resolveTrainingOptimizer(args: CliArguments, integration?: SpawnfileCliIntegration,
  context?: SpawnfileTrainingContext): Promise<CliArguments> {
  if (args.command !== 'train') return args;
  const resolved = context === undefined ? undefined : await integration?.trainingOptimizer?.(context);
  let training = args.training;
  const flags = { ...args.flags };
  if (resolved !== undefined) {
    if (!training) throw new Error(`training.optimizer.model ${resolved.model} requires declared training.models`);
    if (training.comparison) throw new Error('training.optimizer cannot be supplied for comparison');
    const matches = Object.hasOwn(training.models, resolved.model) ? [resolved.model]
      : Object.keys(training.models).filter(name => training!.models[name]!.model === resolved.model);
    if (matches.length !== 1) throw new Error(`training.optimizer.model ${resolved.model} must resolve to exactly one declared named model`);
    const mapped = { ...resolved, model: matches[0]! };
    const authored = training.optimizer;
    for (const field of ['method', 'model', 'variants', 'keep'] as const) {
      if (authored?.[field] !== undefined && authored[field] !== mapped[field]) {
        throw new Error(`training.optimizer.${field} conflicts with the integration optimizer`);
      }
    }
    if (authored?.budget !== undefined && authored.budget.rounds !== mapped.budget.rounds) {
      throw new Error('training.optimizer.budget.rounds conflicts with the integration optimizer');
    }
    training = validateTrainingConfiguration({ ...training, optimizer: { ...authored, ...mapped } });
    const model = training.models[mapped.model]!.model;
    if (flags['optimizer-model'] && flags['optimizer-model'][0] !== model) throw new Error('training.optimizer.model conflicts with --optimizer-model');
    flags['optimizer-model'] = [model];
  }
  const optimizer = training?.optimizer;
  if (optimizer?.variants !== undefined) {
    const maximum = flags['max-proposals'] === undefined
      ? optimizer.budget!.rounds * (optimizer.keep! + optimizer.variants) * (optimizer.proposal?.max_attempts ?? 2)
      : count(args, 'max-proposals', 3, 1000);
    if (!Number.isSafeInteger(maximum) || maximum > 1000) throw new Error('training.budget.max_proposals derived population budget exceeds the 1000 proposal ceiling; declare a smaller cap');
    if (maximum < optimizer.keep! + optimizer.variants) throw new Error('training.budget.max_proposals must be at least optimizer.keep + optimizer.variants');
    flags['max-proposals'] = [String(maximum)];
  }
  return { ...args, training, flags };
}

export function populationSearch(optimizer?: TrainingOptimizer) {
  if (optimizer?.variants === undefined) return undefined;
  return {
    variants: optimizer.variants, keep: optimizer.keep!, rounds: optimizer.budget!.rounds,
    selection: optimizer.selection ?? 'pareto', rewriteShare: optimizer.proposal?.rewrite_share ?? 0.5,
    minChange: optimizer.proposal?.min_change ?? 0.08,
    hypothesisSimilarity: optimizer.proposal?.hypothesis_similarity ?? 0.6,
    patience: optimizer.patience ?? optimizer.budget!.rounds, boundaries: optimizer.boundaries ?? [],
  };
}

/** Population-only policy fields live in search, leaving the GEPA wire shape unchanged. */
export function bridgeProposal(optimizer?: TrainingOptimizer) {
  if (!optimizer?.proposal) return undefined;
  const { rewrite_share, hypothesis_similarity, ...proposal } = optimizer.proposal;
  void rewrite_share;
  void hypothesis_similarity;
  return proposal;
}

export function editableResources(candidate: CandidateManifest) {
  return candidate.resources.filter(resource => resource.edit !== 'locked').map(resource => ({
    resource: resource.sourcePath, scope: resource.edit,
  }));
}
