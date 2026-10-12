import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { type CliArguments } from '../arguments.js';
import type { SpawnfileCliIntegration } from '../types.js';
import type { SpawnfileTrainingContext } from '../spawnfile/index.js';
import { bridgeProposal, populationSearch, resolveTrainingOptimizer } from './optimizer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const models: TrainingConfiguration['models'] = {
  reflect: { provider: 'ollama', model: 'local-model' }, other: { provider: 'ollama', model: 'another-model' },
};
const population = { model: 'reflect', variants: 4, keep: 2, budget: { rounds: 3 } };
const args = (training: TrainingConfiguration = { models, optimizer: population }): CliArguments => ({ command: 'train', flags: {}, training });

it('resolves exact population defaults and keeps new policies out of legacy proposal wire data', async () => {
  expect(populationSearch(population)).toEqual({ variants: 4, keep: 2, rounds: 3, selection: 'pareto',
    rewriteShare: 0.5, minChange: 0.08, hypothesisSimilarity: 0.6, patience: 3, boundaries: [] });
  const optimizer = { ...population, selection: 'top-k' as const, patience: 2, boundaries: ['Do not disclose keys.'],
    proposal: { rewrite_share: 0.25, hypothesis_similarity: 0.7, min_change: 0.2, max_attempts: 3 } };
  expect(populationSearch(optimizer)).toMatchObject({ selection: 'top-k', patience: 2, boundaries: optimizer.boundaries,
    rewriteShare: 0.25, hypothesisSimilarity: 0.7, minChange: 0.2 });
  expect(bridgeProposal(optimizer)).toEqual({ min_change: 0.2, max_attempts: 3 });
  expect(bridgeProposal()).toBeUndefined();
  expect(populationSearch()).toBeUndefined();
  expect(populationSearch({ model: 'reflect' })).toBeUndefined();
  expect((await resolveTrainingOptimizer(args())).flags['max-proposals']).toEqual(['36']);
  expect((await resolveTrainingOptimizer(args({ models, optimizer }))).flags['max-proposals']).toEqual(['54']);
  expect((await resolveTrainingOptimizer({ ...args(), flags: { 'max-proposals': ['6'] } })).flags['max-proposals']).toEqual(['6']);
  await expect(resolveTrainingOptimizer({ ...args(), flags: { 'max-proposals': ['5'] } })).rejects.toThrow('keep + optimizer.variants');
  await expect(resolveTrainingOptimizer(args({ models, optimizer: { ...population, budget: { rounds: 1000 } } }))).rejects.toThrow('ceiling');
});

it('maps integration model keys first, then unique model values, and rejects conflicts', async () => {
  const f = { context: {} as SpawnfileTrainingContext };
  let resolved = { method: 'gepa' as const, ...population };
  const integration = { trainingOptimizer: vi.fn(async () => resolved) } as unknown as SpawnfileCliIntegration;
  expect((await resolveTrainingOptimizer(args(), integration, f.context)).training?.optimizer).toMatchObject(resolved);
  expect(integration.trainingOptimizer).toHaveBeenCalledWith(f.context);
  resolved = { ...resolved, model: 'local-model' };
  expect((await resolveTrainingOptimizer(args({ models }), integration, f.context)).training?.optimizer?.model).toBe('reflect');
  const both = { ...models, 'local-model': models.other! };
  expect((await resolveTrainingOptimizer(args({ models: both }), integration, f.context)).training?.optimizer?.model).toBe('local-model');
  await expect(resolveTrainingOptimizer(args({ models: { ...models, duplicate: models.reflect! } }), integration, f.context)).rejects.toThrow('local-model');
  await expect(resolveTrainingOptimizer({ command: 'train', flags: {} }, integration, f.context)).rejects.toThrow('training.models');
  await expect(resolveTrainingOptimizer(args({ models, comparison: { candidate: { name: 'x', replacements: [] } } }), integration, f.context)).rejects.toThrow('comparison');
  resolved = { ...resolved, model: 'missing' };
  await expect(resolveTrainingOptimizer(args(), integration, f.context)).rejects.toThrow('missing');
  resolved = { method: 'gepa', ...population };
  for (const override of [{ model: 'other' }, { variants: 5 }, { keep: 1 }, { budget: { rounds: 4 } }]) {
    await expect(resolveTrainingOptimizer(args({ models, optimizer: { ...population, ...override } }), integration, f.context)).rejects.toThrow('conflicts');
  }
  await expect(resolveTrainingOptimizer({ ...args(), flags: { 'optimizer-model': ['different'] } }, integration, f.context)).rejects.toThrow('--optimizer-model');
  const unchanged = args({ models });
  expect(await resolveTrainingOptimizer(unchanged, { ...integration, trainingOptimizer: async () => undefined }, f.context)).toEqual(unchanged);
  const help = { command: 'help' as const, flags: {} };
  expect(await resolveTrainingOptimizer(help, integration, f.context)).toBe(help);
});

