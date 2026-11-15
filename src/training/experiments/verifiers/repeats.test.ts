import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { snapshotCandidate } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import * as optimization from '../../optimization/index.js';
import { TrainingCheckpoint } from '../training/index.js';
import { trainAgent, type TrainingOptions } from '../training/index.js';

const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const dataset = (id: string, tokens: [string, string][]) => resolveDataset(parseDatasetYaml(stringify({ schema: 'spawnfile.training.dataset.v1', id,
  records: tokens.map(([token, group]) => ({ id: token, group, input: { prompt: token }, checks: [{ id: 'answer', eval: 'equals', input: 'output.text', value: 'good' }] })) })));

/** A subject whose answer to a case alternates: good on its first trial, bad on its second. */
async function fixture(): Promise<{ options: TrainingOptions; runs: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'training-validation-repeats-')); cleanup.push(root);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), 'Answer.');
  const baseline = await snapshotCandidate({ sourceRoot: source, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md', destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const storeRoot = join(root, 'store'); const store = await openExperimentStore(storeRoot);
  const runs: string[] = [];
  const options: TrainingOptions = {
    id: 'training', baseline, train: dataset('train', [['Alpha', 'a']]), validation: dataset('validation', [['Beta', 'b']]), test: dataset('test', [['Gamma', 'c']]),
    native: { store, storeRoot, root: join(root, 'trials'), model: 'test-model', timeoutMs: 2_000,
      registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
      adapter: { id: 'deterministic-test', capabilities: { toolTrace: 'none', liveObservations: true, cancellation: 'native-handle',
        multiTurn: false, resources: ['instructions'], isolation: 'test facade', readIsolation: 'declared-paths', protectedPaths: true },
      async start() { return {
        async run(turn) {
          runs.push(turn.text);
          return { status: 'completed', text: runs.filter(text => text === turn.text).length % 2 === 1 ? 'good' : 'bad',
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: null, source: 'test' },
            coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
        },
        async stop(reason) { return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }; },
      }; } } },
    inference: { model: 'test-optimizer', provider: { id: 'test', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      async generate() { return { text: 'reflection', model: 'test-optimizer', route: 'test', usage: null }; } } },
    bridge: { command: 'unused-by-unit-facade', cwd: root, timeoutMs: 2_000 }, budget: { maxMetricCalls: 6, maxProposals: 1 },
  };
  return { options, runs };
}

it('runs a validation case once per repeat and hands the search the mean, leaving train cases at one trial', async () => {
  const { options, runs } = await fixture();
  const scores: Record<string, number> = {};
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    const signal = new AbortController().signal;
    scores.train = (await request.evaluate({ split: 'train', caseId: 'Alpha', components: request.components, round: 0 } as never, signal, 'train-callback')).score;
    const validated = await request.evaluate({ split: 'validation', caseId: 'Beta', components: request.components, round: 0 } as never, signal, 'validation-callback');
    scores.validation = validated.score;
    expect(validated).toMatchObject({ output: '', feedback: '' });
    return { components: request.components, provenance: { candidates: [], evaluations: 2, proposals: 0 } } as never;
  });
  const report = await trainAgent({ ...options, validationRepeats: 3 });
  expect(scores).toEqual({ train: 1, validation: 2 / 3 });
  expect(runs.filter(text => text === 'Alpha')).toHaveLength(1);
  expect(report.trials.filter(trial => trial.phase === 'validation').map(trial => trial.status)).toEqual(['pass', 'fail', 'pass']);
  expect(report.trials.filter(trial => trial.phase === 'train')).toHaveLength(1);
});

it('refuses a repeat count outside 1 to 8 and binds a nondefault count into checkpoint identity', async () => {
  const { options } = await fixture();
  await expect(trainAgent({ ...options, validationRepeats: 9 })).rejects.toThrow('training.budget.validation_repeats must be an integer from 1 to 8');
  const datasets = [options.train, options.validation!, options.test];
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'repeats', resume: false };
  await TrainingCheckpoint.open(options, datasets);
  options.checkpoint.resume = true;
  await expect(TrainingCheckpoint.open({ ...options, validationRepeats: 1 }, datasets)).resolves.toBeDefined();
  await expect(TrainingCheckpoint.open({ ...options, validationRepeats: 2 }, datasets)).rejects.toThrow('identity');
  await expect(TrainingCheckpoint.open({ ...options, selection: { max_gap: 0.1 } }, datasets)).rejects.toThrow('identity');
});
