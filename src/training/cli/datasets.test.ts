import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateDatasetSplit } from '../cases/index.js';
import { prepareCliInputs, prepareNative } from './native.js';
import { parseArguments } from './arguments.js';
import { authoredArguments } from './training/index.js';
import { CliDatasets } from './datasets.js';
import { cliFixture } from './fixture.js';
import { createCalibrationIdentity, loadGrader, loadLabels, sha256, stableDigest } from '../graders/index.js';
import { DECISION_PROMPT_VERSION } from '../inference/decision/index.js';
import type { CheckNode, InferenceProvider } from '../contracts/index.js';
import type { DecisionBackend } from '../contracts/grading.js';

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

async function graderFixture() {
  const f = await cliFixture(); roots.push(f.root);
  const definition = { schema: 'paideia.grader.v1', id: 'report', golden: { schema: 'paideia.labels.v1', labelers: {}, labels: [] },
    calibration: 'calibration.json', teachers: [{ id: 'teacher', provider: 'claude', model: 'opus' }],
    model: { backend: 'jev-http', endpoint: 'http://localhost:8080', name: 'decision' },
    escalate: { to: 'teacher', between: [0.4, 0.6], max_calls_per_trial: 1 },
    questions: [{ id: 'q', type: 'yes-no', expected: 'yes', reads: ['output.body'] }], score: { method: 'weighted' } };
  const graderFile = join(f.root, 'grader.yaml');
  await writeFile(graderFile, JSON.stringify(definition));
  const backend: DecisionBackend = { identity: async () => ({ backend: 'jev-http', model: 'decision' }),
    score: async requests => requests.map(request => ({ key: request.key, status: 'ok', probabilities: { yes: 0.99, no: 0.01 } })) };
  const grader = await loadGrader(graderFile), golden = await loadLabels(grader.golden, grader);
  const calibration = { schema: 'paideia.grader-calibration.v1', identity: createCalibrationIdentity(grader, {
    backendModel: stableDigest({ configured: grader.model, reported: await backend.identity() }), golden: golden.goldenDigest,
    promptTemplateVersion: DECISION_PROMPT_VERSION, seed: '0', exclusions: [] }),
    questions: { q: { status: 'calibrated', failures: [], params: { a: 1, b: 0 }, band: [0.4, 0.6],
      metrics: { groups: 20, instances: 40, good: 20, bad: 20, baseRate: 0.5 } } } };
  await writeFile(grader.calibration, JSON.stringify(calibration));
  const check: CheckNode = { id: 'quality', eval: 'grader', grader: 'grader.yaml', input: 'artifact:report' };
  const document = { schema: 'paideia.dataset.v1', id: 'reports', checks: [check], records: [
    { id: 'a', group: 'a', input: { prompt: 'Write report.' }, outputs: { report: 'report.json' } },
    { id: 'b', group: 'b', input: { prompt: 'Write another report.' }, outputs: { report: 'report.json' } },
  ] };
  const provider: InferenceProvider = { id: 'fake', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: async () => { throw new Error('No inference expected during preparation'); } };
  const dependencies = { ...f.dependencies, adapter: vi.fn(f.dependencies.adapter!),
    grader: { backend: vi.fn(() => backend), provider: vi.fn(() => provider) } };
  const datasetFile = join(f.root, 'reports.yaml');
  await writeFile(datasetFile, JSON.stringify(document));
  return { ...f, grader, graderFile, calibration, backend, document, datasetFile, dependencies };
}

it('constructs frozen grader routes before native subjects and makes no inference calls for ordinary datasets', async () => {
  const f = await graderFixture();
  const args = parseArguments(['evaluate', 'reports.yaml', ...f.nativeArgs]);
  const inputs = await prepareCliInputs(args, f.io, f.dependencies);
  inputs.datasets.load('reports.yaml', false);
  const native = await prepareNative(args, f.io, f.dependencies, 1000, inputs);
  expect(native.evaluation.graders[f.graderFile]?.backend).toBe(f.backend);
  expect(f.dependencies.grader.backend).toHaveBeenCalledTimes(1);
  expect(f.dependencies.grader.backend.mock.invocationCallOrder[0]).toBeLessThan(f.dependencies.adapter.mock.invocationCallOrder[0]!);
  await native.closeInference();
  const plain = new CliDatasets({}, f.root); plain.load('data.yaml', false);
  expect(await plain.buildGraders()).toEqual({});
  expect(f.dependencies.grader.backend).toHaveBeenCalledTimes(1);
});

it('rejects grader and calibration edits after resolution before constructing a subject', async () => {
  const f = await graderFixture();
  const args = parseArguments(['evaluate', 'reports.yaml', ...f.nativeArgs]);
  for (const file of [f.graderFile, f.grader.calibration]) {
    const inputs = await prepareCliInputs(args, f.io, f.dependencies);
    inputs.datasets.load('reports.yaml', false);
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(file, 'utf8');
    await writeFile(file, `${text}\n`);
    await expect(prepareNative(args, f.io, f.dependencies, 1000, inputs)).rejects.toThrow('changed after dataset resolution');
  }
  expect(f.dependencies.adapter).not.toHaveBeenCalled();
});

it('requires current train and test exclusion digests including the whole internal-validation source', async () => {
  const f = await graderFixture();
  const testFile = join(f.root, 'test.yaml');
  const testText = JSON.stringify({ ...f.document, id: 'test', records: [{ ...f.document.records[0], id: 'test', group: 'test' }] });
  await writeFile(testFile, testText);
  const args = parseArguments(['train', '--train', 'reports.yaml', '--test', 'test.yaml', ...f.nativeArgs]);
  const inputs = async () => {
    const prepared = await prepareCliInputs(args, f.io, f.dependencies);
    prepared.datasets.load('reports.yaml', true); prepared.datasets.load('test.yaml', true);
    return prepared;
  };
  await expect(prepareNative(args, f.io, f.dependencies, 1000, await inputs())).rejects.toThrow('whole training dataset');
  f.calibration.identity.exclusions.push({ dataset: f.datasetFile, digest: sha256(JSON.stringify(f.document)) });
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  await expect(prepareNative(args, f.io, f.dependencies, 1000, await inputs())).rejects.toThrow('test.yaml');
  f.calibration.identity.exclusions.push({ dataset: testFile, digest: sha256(testText) });
  await writeFile(f.grader.calibration, JSON.stringify(f.calibration));
  const native = await prepareNative(args, f.io, f.dependencies, 1000, await inputs());
  expect(native.evaluation.graders[f.graderFile]).toBeDefined();
  await native.closeInference();
});

it('finds graders in logical nodes, stage conditions/gates, turns and live plans without traversing parameters', async () => {
  const f = await graderFixture();
  const check = f.document.checks[0]!;
  // Resolved plan positions use the same frozen binding; only collection is under test here.
  const datasets = new CliDatasets({}, f.root), resolved = datasets.load('reports.yaml', false);
  const bound = resolved.sharedStages[0]!.checks[0]!;
  resolved.sharedStages = [{ id: 'stage', when: { not: { all: [{ any: [bound] }] } },
    checks: [{ eval: 'equals', input: 'output.text', value: { eval: 'grader', grader: 'must-not-load' } }], gate: bound }];
  resolved.records[0]!.turns = [{ id: 'turn', input: {}, checks: [bound] }, { id: 'without-checks', input: {} }];
  resolved.live.checks = [{ ...bound, id: 'live', on: 'event' }];
  resolved.records[0]!.live.checks = [{ ...bound, id: 'local', on: 'event' }];
  expect(Object.keys(await datasets.buildGraders(f.dependencies.grader))).toEqual([f.graderFile]);
  expect(f.dependencies.grader.backend).toHaveBeenCalledTimes(1);
  expect(check.grader).toBe('grader.yaml');
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
