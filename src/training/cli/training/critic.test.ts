import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JudgeRoute } from '../../contracts/evaluation.js';
import type { CliArguments } from '../arguments.js';
import { trainingCritic } from './critic.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const route = { provider: { id: 'p' }, model: 'strong-model' } as unknown as JudgeRoute;

it('builds the critic from the authored block, reading the house documents beside the train dataset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'critic-cli-')); roots.push(root);
  await writeFile(join(root, 'WRITING.md'), 'Length follows the facts.');
  const args = (critic: unknown) => ({ command: 'train', flags: {}, frozenDataset: { path: join(root, 'train.yaml'), sourceDigest: 'd' },
    training: { models: {}, critic } }) as unknown as CliArguments;
  expect(trainingCritic(args({ judge: 'strong', guide: ['WRITING.md'], show: ['train-tasks'], block_on: 'medium' }), { strong: route })).toEqual({
    judge: { name: 'strong', provider: route.provider, model: 'strong-model' }, guide: [{ name: 'WRITING.md', text: 'Length follows the facts.' }],
    show: { checks: false, trainTasks: true }, blockOn: 'medium' });
  expect(trainingCritic(args({ judge: 'strong', guide: ['WRITING.md'] }), { strong: route })).toMatchObject({ show: { checks: false, trainTasks: false }, blockOn: 'high' });
  expect(trainingCritic(args(undefined), {})).toBeUndefined();
  expect(() => trainingCritic(args({ judge: 'strong', guide: ['WRITING.md'] }), {})).toThrow('Critic judge strong has no configured route');
  expect(() => trainingCritic(args({ judge: 'strong', guide: ['MISSING.md'] }), { strong: route })).toThrow();
});
