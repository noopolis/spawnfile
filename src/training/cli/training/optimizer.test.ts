import { afterEach, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { type CliArguments } from '../arguments.js';
import type { SpawnfileCliIntegration } from '../types.js';
import type { SpawnfileTrainingContext } from '../spawnfile/index.js';
import { bridgeProposal, populationSearch, resolveTrainingOptimizer, trainingTrialBudget } from './optimizer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const models: TrainingConfiguration['models'] = {
  reflect: { provider: 'ollama', model: 'local-model' }, other: { provider: 'ollama', model: 'another-model' },
};
const population = { model: 'reflect', variants: 4, keep: 2, budget: { rounds: 3 } };
const args = (training: TrainingConfiguration = { models, optimizer: population }): CliArguments => ({ command: 'train', flags: {}, training });

it('derives full population trial budgets after case resolution and respects explicit caps', () => {
  expect(trainingTrialBudget(args(), 2, 1, 1)).toBe(41);
  expect(trainingTrialBudget(args(), 3, undefined, 1)).toBe(41); // internal partition preserves total cases
  expect(trainingTrialBudget(args(), 2, 2, 3)).toBe(58);
  expect(trainingTrialBudget({ ...args(), flags: { 'max-trials': ['20'] } }, 2, 1, 1)).toBe(20);
  expect(trainingTrialBudget(args({ models }), 2, 1, 1)).toBe(20);
  expect(trainingTrialBudget({ command: 'evaluate', flags: {} }, 2)).toBe(20);
  const comparison = { candidate: { name: 'frozen', replacements: [{ resource: 'AGENTS.md', source: 'variant.md' }] } };
  expect(trainingTrialBudget(args({ models, comparison }), 2, 1, 1)).toBe(20);
  expect(() => trainingTrialBudget(args(), 1000, 0, 1)).toThrow('10000 trial ceiling');
  expect(trainingTrialBudget({ ...args(), flags: { 'max-trials': ['10000'] } }, 1000, 0, 1)).toBe(10000);
  expect(() => trainingTrialBudget({ ...args(), flags: { 'max-trials': ['10001'] } }, 2, 1, 1)).toThrow('--max-trials');
});

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

it('merges integration hard boundaries only when declared values agree', async () => {
  const context = {} as SpawnfileTrainingContext;
  const boundaries = ['Keep quoted text verbatim.'];
  const integration = (value?: string[]) => ({ trainingOptimizer: async () => ({
    method: 'gepa' as const, ...population, boundaries: value,
  }) }) as unknown as SpawnfileCliIntegration;
  for (const [yaml, supplied] of [[undefined, boundaries], [boundaries, undefined], [boundaries, boundaries]] as const) {
    const result = await resolveTrainingOptimizer(args({ models, optimizer: { ...population, boundaries: yaml } }), integration(supplied), context);
    expect(result.training?.optimizer?.boundaries).toEqual(boundaries);
    expect(populationSearch(result.training?.optimizer)?.boundaries).toEqual(boundaries);
  }
  await expect(resolveTrainingOptimizer(args({ models, optimizer: { ...population, boundaries } }), integration([]), context)).rejects.toThrow('boundaries conflicts');
  for (const invalid of [null, 'rule', [''], ['x'.repeat(501)], Array.from({ length: 51 }, () => 'rule')]) {
    await expect(resolveTrainingOptimizer(args(), integration(invalid as string[]), context)).rejects.toThrow('boundaries');
  }
});


it('comparison bypasses inherited optimizer resolution but rejects an explicit optimizer', async () => {
  const comparison = { candidate: { name: 'frozen', replacements: [{ resource: 'AGENTS.md', source: 'variant.md' }] } };
  const integration = { trainingOptimizer: vi.fn(async () => { throw new Error('Must not resolve inherited optimizer'); }) } as unknown as SpawnfileCliIntegration;
  const input = args({ models, comparison });
  expect(await resolveTrainingOptimizer(input, integration, {} as SpawnfileTrainingContext)).toBe(input);
  await expect(resolveTrainingOptimizer(args({ models, comparison, optimizer: population }), integration,
    {} as SpawnfileTrainingContext)).rejects.toThrow('comparison does not run an optimizer');
  expect(integration.trainingOptimizer).not.toHaveBeenCalled();
});

it('reserves repeated sealed passes in derived budgets while preserving explicit and legacy caps', () => {
  const repeated = args({ models, optimizer: population, budget: { test_repeats: 3 } });
  expect(trainingTrialBudget(repeated, 2, 1, 2)).toBe(51);
  expect(trainingTrialBudget({ ...repeated, flags: { 'max-trials': ['20'] } }, 2, 1, 2)).toBe(20);
  expect(trainingTrialBudget(args({ models, budget: { test_repeats: 3 } }), 2, 1, 2)).toBe(20);
  expect(() => trainingTrialBudget(args({ models, optimizer: population, budget: { test_repeats: 8 } }), 1, 1, 625)).toThrow('10000');
});
