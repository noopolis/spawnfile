import { basename, dirname, resolve } from 'node:path';
import type { JudgeRoute } from '../../contracts/evaluation.js';
import type { TrainingOptions } from '../../experiments/index.js';
import type { CliArguments } from '../arguments.js';
import { readCliText } from '../datasets.js';

/** The authored critic as run options: its named judge route and the house documents, read beside the train dataset. */
export function trainingCritic(args: CliArguments, judges: Readonly<Record<string, JudgeRoute>>): TrainingOptions['critic'] {
  const critic = args.training?.critic;
  if (!critic) return undefined;
  const route = Object.hasOwn(judges, critic.judge) ? judges[critic.judge] : undefined;
  if (!route) throw new Error(`Critic judge ${critic.judge} has no configured route`);
  const base = dirname(args.frozenDataset!.path);
  return { judge: { name: critic.judge, provider: route.provider, model: route.model },
    guide: critic.guide.map(file => ({ name: basename(file), text: readCliText(resolve(base, file), 2_000_000) })),
    show: { checks: critic.show?.includes('checks') ?? false, trainTasks: critic.show?.includes('train-tasks') ?? false },
    blockOn: critic.block_on ?? 'high' };
}
