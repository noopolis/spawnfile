import { afterEach, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { parseArguments } from '../arguments.js';
import type { SpawnfileCliIntegration } from '../types.js';
import { contextFixture } from '../../../../fixtures/support/training/spawnfile-fixture.js';
import { cliFixture, datasetText } from '../../../../fixtures/support/training/cli-fixture.js';
import { main } from '../commands.js';
import { authoredArguments, populationSearch } from '../training/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true }))); });
const models: TrainingConfiguration['models'] = {
  reflect: { provider: 'ollama', model: 'local-model' }, other: { provider: 'ollama', model: 'another-model' },
};
const population = { model: 'reflect', variants: 4, keep: 2, budget: { rounds: 3 } };

it.each(['file', 'in-process'])('CLI %s context uses the integration optimizer and shows whole-file scope without execution', async mode => {
  const context = await contextFixture(), f = await cliFixture(); roots.push(context.root, f.root);
  await writeFile(join(f.root, 'train.yaml'), `${datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }])}\ntraining: ${JSON.stringify({ models })}\n`);
  await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'x', group: 'x' }]).replace('id: example', 'id: sealed'));
  const forbidden = vi.fn(() => { throw new Error('No execution during dry-run'); });
  const optimizer = vi.fn(async () => ({ method: 'gepa' as const, ...population, model: 'local-model' }));
  const dependencies = { ...(mode === 'in-process' ? { spawnfileContext: context.context } : {}) };
  if (mode === 'in-process') await rm(context.path);
  const integration: SpawnfileCliIntegration = { id: 'fixture', version: '1', createAdapter: forbidden,
    prepareEnvironment: forbidden, trainingOptimizer: optimizer };
  const argv = ['train', ...(mode === 'file' ? ['--spawnfile-context', context.path] : []), '--train', 'train.yaml', '--test', 'test.yaml',
    '--editable', 'AGENTS.md', '--dry-run'];
  expect(await main(argv, f.io, { ...dependencies, spawnfile: integration, inference: forbidden }), f.stderr.join('')).toBe(0);
  expect(optimizer).toHaveBeenCalledWith(context.context);
  const plan = JSON.parse(f.stdout[0]!);
  expect(plan).toMatchObject({ modelCallsMade: 0, budget: { maxProposals: 36 }, search: populationSearch(population),
    editableResources: [{ resource: 'AGENTS.md', scope: 'whole-file' }] });
  expect(forbidden).not.toHaveBeenCalled();
  expect(authoredArguments(parseArguments(argv), f.io).training).toEqual({ models });
  expect(plan.budget.maxTrials).toBe(28);
  await writeFile(join(f.root, 'validation.yaml'), datasetText([{ id: 'v', group: 'v' }]).replace('id: example', 'id: validation'));
  f.stdout.length = 0;
  expect(await main([...argv, '--validation', 'validation.yaml'], f.io, { ...dependencies, spawnfile: integration }), f.stderr.join('')).toBe(0);
  expect(JSON.parse(f.stdout[0]!).budget.maxTrials).toBe(41);
  const text = datasetText([{ id: 'a', group: 'a' }, { id: 'b', group: 'b' }]);
  await writeFile(join(f.root, 'train.yaml'), `${text}\ntraining: ${JSON.stringify({ models, budget: { max_proposals: 8, max_trials: 20 } })}\n`);
  f.stdout.length = 0;
  expect(await main(argv, f.io, { ...dependencies, spawnfile: integration }), f.stderr.join('')).toBe(0);
  expect(JSON.parse(f.stdout[0]!).budget.maxProposals).toBe(8);
  expect(JSON.parse(f.stdout[0]!).budget.maxTrials).toBe(20);
  await writeFile(join(f.root, 'train.yaml'), `${text}\ntraining: ${JSON.stringify({ models, optimizer: { ...population, keep: 1 } })}\n`);
  expect(await main(argv, f.io, { ...dependencies, spawnfile: integration })).toBe(2);
  expect(f.stderr.join('')).toContain('training.optimizer.keep conflicts');
  expect(forbidden).not.toHaveBeenCalled();
});
