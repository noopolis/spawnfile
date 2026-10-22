import { afterEach, expect, it, vi } from 'vitest';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contextFixture } from './spawnfile/fixture.js';
import { main } from './commands.js';
import { CliDatasets } from './datasets.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('public Spawnfile dry-run estimates an unavailable preparation without invoking plugin, native or inference code', async () => {
  const f = await contextFixture(); roots.push(f.root);
  const dataset = (groups: string[]) => ({ schema: 'paideia.dataset.v1', id: groups.join('-'), subject: 'writer',
    setup: { profile: 'fixture/custom', artifacts: { article: { kind: 'trusted' } } },
    fixtures: { task: { setup: { date: { context: 'date' } }, input: { prompt: 'Write.' } } },
    checks: [{ id: 'quality', eval: 'llm-rubric', judge: 'quality', input: 'artifact:article', minimum: 0.8, rubric: { file: 'rubric.md' } }],
    records: groups.map(group => ({ id: group, group, use: ['task'], context: { date: group } })) });
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify(dataset(['a', 'b'])));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(dataset(['c'])));
  await writeFile(join(f.root, 'rubric.md'), 'Verify the article.');
  const before = await readdir(f.root), stdout: string[] = [], stderr: string[] = [];
  const io = { cwd: f.root, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) };
  const args = ['train', '--spawnfile-context', f.path, '--train', 'train.yaml', '--test', 'test.yaml', '--editable', 'AGENTS.md',
    '--optimizer-model', 'claude-fable-5-1', '--judge', 'quality=claude-fable-5-1', '--dry-run'];
  const blocked = vi.fn(() => { throw Error('No project/native/inference callbacks during estimation'); });
  const dependencies = { adapter: blocked, inference: blocked, spawnfile: { id: 'fixture', version: '1',
    preparations: { 'fixture/custom': { version: '1', unlockedPaths: [], validate: blocked } },
    createAdapter: blocked, prepareEnvironment: blocked } };
  for (const integration of [undefined, dependencies.spawnfile]) {
    stdout.length = 0;
    expect(await main(args, io, { ...dependencies, spawnfile: integration })).toBe(0);
    const plan = JSON.parse(stdout.join(''));
    expect(plan.preparationValidation).toEqual({ status: 'unverified', profiles: ['fixture/custom'], checks: ['availability', 'locks', 'parameter-semantics'] });
    expect(plan.lines.map((line: { role: string; plannedCalls: number }) => [line.role, line.plannedCalls]))
      .toEqual([['subject', 18], ['subject', 2], ['judge', 18], ['judge', 2], ['optimizer', 3]]);
    expect(plan.modelCallsMade).toBe(0);
    expect(plan.warnings.join(' ')).toContain('not execution readiness');
  }
  expect(blocked).not.toHaveBeenCalled(); expect(stderr).toEqual([]);
  expect(await readdir(f.root)).toEqual(before);
  expect(() => new CliDatasets({ quality: 'model' }, f.root).load('train.yaml', true)).toThrow('unsupported preparation');
  await rm(join(f.root, 'rubric.md'));
  expect(await main(args, io)).toBe(2);
});
