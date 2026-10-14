import { afterEach, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandDeadlines } from './deadlines.js';
import { authoredArguments } from './configuration.js';
import { parseArguments } from '../arguments.js';
import { main } from '../commands.js';
import { cliFixture, datasetText, fixtureAdapter } from '../fixture.js';
import { createTrainingInference } from './inference.js';
import { openExperimentStore } from '../../storage/index.js';
import type { CliDependencies } from '../types.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it('defaults to twelve hours for the experiment, one hour per trial and thirty minutes per inference call', () => {
  expect(commandDeadlines(parseArguments(['train', '--train', 'train.yaml']))).toEqual({
    experimentMs: 43_200_000, trialMs: 3_600_000, inferenceMs: 1_800_000 });
  expect(commandDeadlines(parseArguments(['evaluate', 'data.yaml']))).toEqual({
    experimentMs: 180_000, trialMs: 180_000, inferenceMs: 180_000 });
  expect(commandDeadlines(parseArguments(['view', 'out', '--timeout-ms', '500']))).toEqual({
    experimentMs: 500, trialMs: 500, inferenceMs: 500 });
});

it.each([7_200_000, 86_400_000])('accepts a %i ms trial override independently of experiment and inference deadlines', trialMs => {
  expect(commandDeadlines(parseArguments(['train', '--train', 'train.yaml', '--trial-timeout-ms', String(trialMs)]))).toEqual({
    experimentMs: 43_200_000, trialMs, inferenceMs: 1_800_000 });
});

it.each([
  [[], 50_000_000],
  [['--timeout-ms', '60000000'], 60_000_000],
  [['--experiment-timeout-ms', '70000000'], 70_000_000],
  [['--timeout-ms', '60000000', '--experiment-timeout-ms', '70000000'], 70_000_000],
])('keeps CLI experiment overrides ahead of either authored spelling: %j', async (flags, expected) => {
  const f = await cliFixture(); roots.push(f.root);
  for (const budget of [{ timeout_ms: 50_000_000 }, { experiment_timeout_ms: 50_000_000, timeout_ms: 1000 }]) {
    await writeFile(join(f.root, 'train.yaml'), `${datasetText()}\ntraining: ${JSON.stringify({
      models: { unused: { provider: 'ollama', model: 'unused' } }, budget: { ...budget, trial_timeout_ms: 5_000_000 } })}`);
    const argv = ['train', '--train', 'train.yaml', ...flags];
    const args = authoredArguments(parseArguments(argv), f.io);
    expect(commandDeadlines(args)).toEqual({ experimentMs: expected, trialMs: 5_000_000, inferenceMs: 1_800_000 });
    expect(commandDeadlines(authoredArguments(parseArguments([...argv, '--trial-timeout-ms', '2000']), f.io)).trialMs).toBe(2000);
  }
});

it.each(['timeout-ms', 'experiment-timeout-ms', 'trial-timeout-ms'])('rejects invalid --%s even during dry-run', async flag => {
  const f = await cliFixture(); roots.push(f.root);
  for (const value of ['0', '1.5', 'NaN', '604800001']) {
    const args = ['train', '--train', 'data.yaml', '--dry-run', `--${flag}`, value];
    expect(await main(args, f.io, f.dependencies)).toBe(2);
    expect(f.stderr.at(-1)).toContain(`--${flag} must be an integer`);
  }
  expect(f.observedInstructions).toEqual([]);
});

it('honors independent route deadlines at the provider and does not share differently bounded instances', () => {
  const modelInference = vi.fn((_model: unknown, _timeoutMs: number) => ({ id: 'fixture', capabilities: {
    tools: 'disabled' as const, billing: 'local' as const, seed: false, temperature: false }, generate: vi.fn() }));
  createTrainingInference({ command: 'train', flags: {}, training: {
    models: { local: { provider: 'ollama', model: 'local' } },
    judges: { quick: { model: 'local', timeout_ms: 1000 } }, optimizer: { model: 'local', timeout_ms: 3_600_000 },
  } }, { modelInference }, 1_800_000, { quick: 'local' }, { quick: 0 });
  expect(modelInference.mock.calls.map(call => call[1])).toEqual([1000, 3_600_000]);
});

it('uses the experiment timer and preserves completed trial IDs when --resume follows deadline interruption', async () => {
  const f = await cliFixture(); roots.push(f.root);
  await writeFile(join(f.root, 'variant.md'), 'IMPROVED\n');
  await writeFile(join(f.root, 'train.yaml'), `${datasetText([{ id: 'train', group: 'a' }, { id: 'validation', group: 'b' }])}
training:
  models: { unused: { provider: ollama, model: unused } }
  comparison:
    candidate:
      name: Variant
      replacements: [{ resource: AGENTS.md, source: variant.md }]
  budget: { max_trials: 6 }
  validation_groups: [b]
  test: test.yaml
`);
  await writeFile(join(f.root, 'test.yaml'), datasetText([{ id: 'sealed', group: 'sealed' }]));
  const argv = ['train', '--train', 'train.yaml', ...f.nativeArgs, '--editable', 'AGENTS.md'];
  let expire: (() => void) | undefined;
  const setTimer = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms?: number, ...args: unknown[]) => {
    if (ms === 43_200_000) expire = callback;
    return setTimer(callback, ms, ...args);
  }) as typeof setTimeout);
  const dependencies: CliDependencies = { ...f.dependencies, adapter: vi.fn((runtime, options) => {
    expect(options.timeoutMs).toBe(3_600_000);
    return fixtureAdapter(runtime, f.observedInstructions);
  }) };
  let finishedId: string | undefined;
  expect(await main(argv, { ...f.io, stdout(text) {
    f.stdout.push(text);
    const event = JSON.parse(text);
    if (event.type === 'trial.finished') { finishedId = event.trialId; expect(expire).toBeDefined(); expire!(); }
  } }, dependencies)).toBe(2);
  expect(f.stderr).toEqual(['CLI command deadline exceeded\n']);
  expect(finishedId).toBeDefined();
  expect(f.observedInstructions).toHaveLength(1);
  f.stderr.length = 0;
  expect(await main([...argv, '--resume'], f.io, dependencies), f.stderr.join('')).toBe(0);
  expect(f.observedInstructions).toHaveLength(6);
  const index = JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8'));
  expect(index.trialIds.filter((id: string) => id === finishedId)).toHaveLength(1);
  const store = await openExperimentStore(join(f.root, 'out'));
  const report = JSON.parse((await store.readBlob(index.report, { audience: 'operator', phase: 'test',
    frozenCandidateIds: [index.candidateId] })).toString());
  expect(report.trials).toHaveLength(6);
  expect(report.trials.filter((trial: { id: string }) => trial.id === finishedId)).toHaveLength(1);
  expect(vi.mocked(globalThis.setTimeout).mock.calls.filter(call => call[1] === 3_600_000)).toHaveLength(6);
  expect(f.stdout.some(text => { const event = JSON.parse(text); return event.type === 'trial.restored' && event.trialId === finishedId; })).toBe(true);
  expect(await main([...argv, '--resume'], f.io, dependencies)).toBe(0);
  expect(f.observedInstructions).toHaveLength(6);
  expect(JSON.parse(await readFile(join(f.root, 'out/invocation.json'), 'utf8')).trialIds).toEqual(index.trialIds);
});
