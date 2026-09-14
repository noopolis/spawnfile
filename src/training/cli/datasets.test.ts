import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDatasetSplit } from '../cases/index.js';
import { prepareCliInputs } from './native.js';
import { parseArguments } from './arguments.js';
import { authoredArguments } from './training/index.js';
import { CliDatasets } from './datasets.js';
import { cliFixture } from './fixture.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const rubricDataset = (file: string) => `schema: paideia.dataset.v1\nid: rubric\nrecords:\n  - id: item\n    input: {prompt: reply}\n    checks:\n      - id: checked\n        eval: llm-rubric\n        input: output.text\n        judge: quality\n        minimum: 0.5\n        rubric: {file: ${JSON.stringify(file)}}\n`;

describe('dataset and criterion loading', () => {
  it('loads real YAML and freezes explicit criterion bytes without future filesystem reads', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const datasets = new CliDatasets({ quality: 'explicit-model' }, fixture.root);
    expect(datasets.load('data.yaml', true).records).toHaveLength(1);
    await writeFile(join(fixture.root, 'rubric.md'), 'Original criterion.');
    await writeFile(join(fixture.root, 'rubric.yaml'), rubricDataset('rubric.md'));
    const loaded = datasets.load('rubric.yaml', false);
    expect(loaded.criterionFileDigests['rubric.md']).toMatch(/^sha256:/);
    datasets.load('rubric.yaml', false);
    await writeFile(join(fixture.root, 'rubric.md'), 'Changed criterion.');
    expect(await datasets.readCriterion('rubric.md')).toBe('Original criterion.');
    expect(() => datasets.load('rubric.yaml', false)).toThrow('Ambiguous criterion sidecar');
    await expect(datasets.readCriterion('private')).rejects.toThrow('not frozen');
  });
  it('rejects non-files, oversized inputs, invalid UTF-8 and escaping sidecars', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const datasets = new CliDatasets({ quality: 'model' }, fixture.root);
    expect(() => datasets.load('.', false)).toThrow('bounded regular');
    await writeFile(join(fixture.root, 'large.yaml'), 'x'.repeat(2_000_001));
    expect(() => datasets.load('large.yaml', false)).toThrow('bounded regular');
    await writeFile(join(fixture.root, 'invalid.yaml'), Buffer.from([0xff]));
    expect(() => datasets.load('invalid.yaml', false)).toThrow();
    for (const file of ['../secret.md', '/secret.md', 'a\\b.md', './rubric.md', 'a//b.md']) {
      await writeFile(join(fixture.root, 'rubric.yaml'), rubricDataset(file));
      expect(() => datasets.load('rubric.yaml', false)).toThrow('relative path');
    }
    await mkdir(join(fixture.root, 'nested'));
    await symlink(join(fixture.root, 'AGENTS.md'), join(fixture.root, 'nested', 'escape.md'));
    await writeFile(join(fixture.root, 'nested', 'rubric.yaml'), rubricDataset('escape.md'));
    expect(() => datasets.load('nested/rubric.yaml', false)).toThrow('escapes its dataset directory');
  });
});


it('validates configured train and inherited test through actual CLI resolution in one image, preserving drift rejection', async () => {
  const f = await cliFixture(); roots.push(f.root);
  const config = { models: { judge: { provider: 'ollama', model: 'small' } }, judges: { prose: { model: 'judge' } } };
  const document = (id: string, training?: unknown) => ({ schema: 'paideia.dataset.v1', id, ...(training ? { training } : {}),
    checks: [{ id: 'prose', eval: 'llm-rubric', judge: 'prose', input: 'output.text', minimum: 0.8, rubric: { prompt: 'Grounded.' } }],
    records: [{ id, group: id, input: { prompt: `Write ${id}.` } }] });
  await writeFile(join(f.root, 'train.yaml'), JSON.stringify(document('train', config)));
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(document('test')));
  const args = authoredArguments(parseArguments(['train', ...f.nativeArgs, '--train', 'train.yaml', '--test', 'test.yaml']), f.io);
  const prepare = (inferenceExecutionIdentity: string) => prepareCliInputs(args, f.io, { ...f.dependencies,
    spawnfile: { id: 'fixture', version: '1', inferenceExecutionIdentity,
      createAdapter() { throw new Error('No cognition'); }, async prepareEnvironment() { throw new Error('No preparation'); } } });
  const first = await prepare('image:one');
  const train = first.datasets.load('train.yaml', true), test = first.datasets.load('test.yaml', true);
  expect(train.registryVersions).toEqual(test.registryVersions);
  expect(() => validateDatasetSplit(train, test)).not.toThrow();
  const other = await prepare('image:two');
  expect(() => validateDatasetSplit(train, other.datasets.load('test.yaml', true))).toThrow('shared evaluation plan drift');
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(document('test', {
    ...config, models: { judge: { provider: 'ollama', model: 'different' } } })));
  expect(() => validateDatasetSplit(train, first.datasets.load('test.yaml', true))).toThrow('shared evaluation plan drift');
  const rubric = document('test'); rubric.checks[0]!.rubric.prompt = 'Different criterion.';
  await writeFile(join(f.root, 'test.yaml'), JSON.stringify(rubric));
  expect(() => validateDatasetSplit(train, first.datasets.load('test.yaml', true))).toThrow('shared evaluation plan drift');
});
