import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main, type InvocationIndex } from './index.js';
import { openExperimentStore } from '../storage/index.js';
import type { TrainingReport } from '../experiments/index.js';
import { cliFixture, datasetText, fixtureAdapter } from './fixture.js';
import { loadInvocationViewer } from './viewer.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('CLI through actual cases/candidates/experiments/storage', () => {
  it('validates a real file and shows help without invoking native or inference work', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    expect(await main(['--help'], fixture.io)).toBe(0);
    expect(fixture.stdout.join('')).toContain('whole-command deadline');
    fixture.stdout.length = 0;
    expect(await main(['validate', 'data.yaml'], fixture.io)).toBe(0);
    expect(JSON.parse(fixture.stdout[0]!)).toMatchObject({ status: 'valid', records: 1 });
    expect(await main(['unknown'], fixture.io)).toBe(2);
    expect(fixture.stderr.join('')).toContain('Unsupported command');
  });

  it.each(['pass', 'candidate', 'failed'] as const)('persists actual %s trial evidence and reports the right exit status', async (mode) => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    fixture.dependencies.adapter = (id) => fixtureAdapter(id, fixture.observedInstructions, mode);
    const code = await main(['evaluate', 'data.yaml', ...fixture.nativeArgs, '--supporting', 'support.md'], fixture.io, fixture.dependencies);
    expect(code).toBe(mode === 'pass' ? 0 : mode === 'candidate' ? 1 : 2);
    expect(fixture.observedInstructions).toEqual(['BASE\n']);
    const index = JSON.parse(await readFile(join(fixture.root, 'out', 'invocation.json'), 'utf8')) as InvocationIndex;
    const store = await openExperimentStore(join(fixture.root, 'out'));
    const bytes = await store.readBlob(index.report, { audience: 'evaluator', phase: 'replay' });
    const report = JSON.parse(bytes.toString());
    expect(report.trials).toHaveLength(1);
    expect(report.trials[0].execution).toBe(mode === 'failed' ? 'failed' : 'completed');
    expect(index.phase).toBe('train');
    expect(fixture.stdout.join('')).not.toContain('Reply OK.');
  });

  it('executes real DSPy GEPA from CLI flags and seals the frozen native comparison', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    await writeFile(join(fixture.root, 'train.yaml'), datasetText([{ id: 'train', group: 'a' }, { id: 'selection', group: 'b' }]));
    await writeFile(join(fixture.root, 'test.yaml'), datasetText([{ id: 'test', group: 'sealed' }]));
    const code = await main(['train', '--train', 'train.yaml', '--test', 'test.yaml', ...fixture.nativeArgs,
      '--editable', 'AGENTS.md', '--optimizer-model', 'explicit-reflection', '--bridge-command', fixture.bridge,
      '--validation-group', 'b', '--max-trials', '6', '--max-proposals', '1', '--timeout-ms', '15000', '--view', '0'], fixture.io, fixture.dependencies);
    expect(fixture.stderr).toEqual([]); expect(code).toBe(0);
    const index = JSON.parse(await readFile(join(fixture.root, 'out', 'invocation.json'), 'utf8')) as InvocationIndex;
    const store = await openExperimentStore(join(fixture.root, 'out'));
    const report = JSON.parse((await store.readBlob(index.report, { audience: 'evaluator', phase: 'test',
      frozenCandidateIds: [index.candidateId] })).toString()) as TrainingReport;
    expect(report.optimizer.provenance).toMatchObject({ optimizer: 'dspy.GEPA', evaluations: 4, proposals: 1 });
    expect(report.trials).toHaveLength(6);
    expect(report.heldOut.map((entry) => entry.meanScore)).toEqual([0, 1]);
    expect(fixture.observedInstructions.filter((instructions) => instructions.includes('IMPROVED'))).toHaveLength(3);
    expect(report.selected.resources[0]!.content).toContain('IMPROVED');
    const exported = JSON.parse(await readFile(join(fixture.root, 'out', 'REPORT.json'), 'utf8'));
    expect(exported.selectedCandidateId).toBe(report.selected.id);
    expect(exported.candidates).toHaveLength(report.optimizer.provenance.candidates.length);
    expect(await readFile(join(fixture.root, 'out', 'REPORT.md'), 'utf8')).toContain('Held-out comparison and uncertainty');
    expect(index.trainingExport).toBeDefined();
    await expect(store.readBlob(index.report, { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
    const data = await (await loadInvocationViewer(join(fixture.root, 'out')))();
    expect(data.optimizer).toMatchObject({ evaluations: 4, proposals: 1, maxMetricCalls: 4 });
    expect(data.cases.some((record) => record.split === 'test')).toBe(true);
    expect(JSON.stringify(data)).not.toContain('Reply OK.');
  });

  it('rejects subject-budget overflow and missing sealed-test reserve before cognition', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    await writeFile(join(fixture.root, 'data.yaml'), datasetText([{ id: 'one', group: 'one' }, { id: 'two', group: 'two' }]));
    expect(await main(['evaluate', 'data.yaml', ...fixture.nativeArgs, '--max-trials', '1'], fixture.io, fixture.dependencies)).toBe(2);
    expect(fixture.stderr.join('')).toContain('no records are silently dropped');
    expect(await main(['train', '--train', 'data.yaml', '--test', 'data.yaml', ...fixture.nativeArgs, '--max-trials', '4'], fixture.io, fixture.dependencies)).toBe(2);
    expect(fixture.stderr.join('')).toContain('reserved sealed-test');
    expect(fixture.observedInstructions).toEqual([]);
  });

  it('returns cancellation and bounds a native callback that ignores the command deadline', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    const controller = new AbortController(); controller.abort();
    expect(await main(['validate', 'data.yaml'], { ...fixture.io, signal: controller.signal })).toBe(130);
    fixture.dependencies.adapter = (id) => fixtureAdapter(id, [], 'stalled');
    expect(await main(['evaluate', 'data.yaml', ...fixture.nativeArgs, '--timeout-ms', '100'], fixture.io, fixture.dependencies)).toBe(2);
    expect(fixture.stderr.join('')).toContain('deadline exceeded');
    expect(JSON.parse(await readFile(join(fixture.root, 'out', 'invocation.json'), 'utf8')))
      .toMatchObject({ outcome: 'failed', command: 'evaluate', phase: 'train' });
  });

  it('retains completed artifact success when cancellation arrives after persistence', async () => {
    const fixture = await cliFixture(); roots.push(fixture.root);
    fixture.dependencies.adapter = (id) => fixtureAdapter(id, [], 'pass');
    const controller = new AbortController();
    const code = await main(['evaluate', 'data.yaml', ...fixture.nativeArgs], { ...fixture.io, signal: controller.signal,
      stdout: (text) => { fixture.stdout.push(text); if (JSON.parse(text).status === 'completed') controller.abort(); },
    }, fixture.dependencies);
    expect(controller.signal.aborted).toBe(true); expect(code).toBe(0);
    expect(JSON.parse(await readFile(join(fixture.root, 'out', 'invocation.json'), 'utf8')).trialIds).toHaveLength(1);
    expect(fixture.stderr).toEqual([]);
  });
});

it('validates concurrency bounds before dry-run can ignore them', async () => {
  const fixture = await cliFixture(); roots.push(fixture.root);
  expect(await main(['train', '--train', 'data.yaml', '--dry-run', '--concurrency', '9'], fixture.io, fixture.dependencies)).toBe(2);
  expect(fixture.stderr.join('')).toContain('integer');
  expect(fixture.observedInstructions).toEqual([]);
});

it('exports a real DSPy training command without a viewer or external reporting script', async () => {
  const fixture = await cliFixture(); roots.push(fixture.root);
  await writeFile(join(fixture.root, 'train.yaml'), datasetText([{ id: 'train', group: 'a' }, { id: 'selection', group: 'b' }]));
  await writeFile(join(fixture.root, 'test.yaml'), datasetText([{ id: 'test', group: 'sealed' }]));
  expect(await main(['train', '--train', 'train.yaml', '--test', 'test.yaml', ...fixture.nativeArgs,
    '--editable', 'AGENTS.md', '--optimizer-model', 'explicit-reflection', '--bridge-command', fixture.bridge,
    '--validation-group', 'b', '--max-trials', '6', '--max-proposals', '1', '--timeout-ms', '15000'], fixture.io, fixture.dependencies)).toBe(0);
  expect(fixture.stderr).toEqual([]);
  const root = join(fixture.root, 'out');
  const index = JSON.parse(await readFile(join(root, 'invocation.json'), 'utf8')) as InvocationIndex;
  expect(index.trainingExport).toBeDefined();
  const report = JSON.parse(await readFile(join(root, 'REPORT.json'), 'utf8'));
  expect(report.heldOut).toMatchObject({ complete: true, meanDelta: 1, standardError: null });
  expect(report.candidates).toHaveLength(2);
  expect(report.durationMs).toBeGreaterThan(0);
  expect(report.candidates[1].splits.test.examples[0].measurements[0].durationMs).toBeGreaterThan(0);
  expect(await readFile(join(root, index.trainingExport!.directory, 'candidates', 'candidate-1', 'files', 'AGENTS.md'), 'utf8')).toContain('IMPROVED');
});


it('exports rejected real GEPA proposals and preserves manifests/rounds on completed resume', async () => {
  const f = await cliFixture(); roots.push(f.root);
  const data = (records: { id: string; group: string }[]) => JSON.stringify({ schema: 'paideia.dataset.v1', id: 'example',
    stages: [{ id: 'quality', checks: [
      { id: 'correct', eval: 'equals', input: 'output.text', value: 'OK' },
      { id: 'ceiling', eval: 'equals', input: 'output.text', value: 'UNREACHABLE' }],
      score: { linear: { correct: 1, ceiling: 1 } },
      gate: { eval: 'contains-any', input: 'output.text', values: ['OK', 'BAD'] } }],
    records: records.map(record => ({ ...record, input: { prompt: 'Reply OK.' } })) });
  await writeFile(join(f.root, 'train.yaml'), data([{ id: 'train', group: 'a' }, { id: 'selection', group: 'b' }]));
  await writeFile(join(f.root, 'test.yaml'), data([{ id: 'test', group: 'sealed' }]));
  f.dependencies.adapter = id => {
    const base = fixtureAdapter(id, f.observedInstructions, 'pass');
    return { ...base, async start(input) {
      const text = input.instructions.includes('IMPROVED') ? 'BAD' : 'OK';
      const native = await base.start({ ...input, onObservation: value => input.onObservation({ ...value, text }) });
      return { ...native, async run(turn, signal) { return { ...await native.run(turn, signal), text }; } };
    } };
  };
  const argv = ['train', '--train', 'train.yaml', '--test', 'test.yaml', ...f.nativeArgs,
    '--editable', 'AGENTS.md', '--optimizer-model', 'explicit-reflection', '--bridge-command', f.bridge,
    '--validation-group', 'b', '--max-trials', '6', '--max-proposals', '1', '--timeout-ms', '15000'];
  expect(await main(argv, f.io, f.dependencies)).toBe(0); expect(f.stderr).toEqual([]);
  const out = join(f.root, 'out'), store = await openExperimentStore(out);
  const index = JSON.parse(await readFile(join(out, 'invocation.json'), 'utf8')) as InvocationIndex;
  const original = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test',
    frozenCandidateIds: [index.candidateId] })).toString()) as TrainingReport;
  expect(original.optimizer.provenance).toMatchObject({ evaluations: 3, candidates: [expect.anything()] });
  expect(original.optimizer.provenance.candidates).toHaveLength(1);
  expect(original.trials.filter(trial => trial.phase !== 'test').map(trial => trial.round)).toEqual([0, 1, 1]);
  const rejected = original.trials.find(trial => trial.candidateId !== original.baseline.id)!;
  expect(rejected.candidate!.resources[0]!.content).toContain('IMPROVED');
  const exported = JSON.parse(await readFile(join(out, 'REPORT.json'), 'utf8'));
  expect(exported.candidates).toHaveLength(2); expect(exported.selectedCandidateId).toBe(original.baseline.id);
  expect(exported.roundScores[1].candidates[1]).toMatchObject({ train: 0, validation: null, test: null });
  expect(await readFile(join(out, index.trainingExport!.directory, 'candidates/candidate-1/files/AGENTS.md'), 'utf8')).toContain('IMPROVED');
  expect(await readFile(join(out, index.trainingExport!.directory, 'candidates/candidate-1/baseline.diff'), 'utf8')).toContain('+IMPROVED');
  const nativeCount = f.observedInstructions.length;
  expect(await main([...argv, '--resume'], f.io, f.dependencies)).toBe(0); expect(f.stderr).toEqual([]);
  expect(f.observedInstructions).toHaveLength(nativeCount);
  const resumed = JSON.parse(await readFile(join(out, 'REPORT.json'), 'utf8'));
  expect(resumed.candidates).toEqual(exported.candidates); expect(resumed.roundScores).toEqual(exported.roundScores);
});
