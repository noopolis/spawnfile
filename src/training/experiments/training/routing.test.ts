import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { snapshotCandidate } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import { createRoutedInference, InferenceFailure } from '../../inference/index.js';
import type { InferenceAttempt, InferenceProvider } from '../../contracts/execution.js';
import * as optimization from '../../optimization/index.js';
import { trainAgent, type TrainingOptions } from './training.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const article = 'Factory orders rose 3 percent.';
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: null, source: 'test' };
function provider(id: string, generate: InferenceProvider['generate'], billing: 'local' | 'subscription' = 'local'): InferenceProvider {
  return { id, capabilities: { tools: 'disabled', billing, temperature: false, seed: false }, generate };
}
function judgment(score = 1) {
  return { text: JSON.stringify({ score, verdict: score >= 0.8 ? 'pass' : 'fail', reasons: ['Focused criterion'],
    citations: [{ source: 'input', quote: article }] }), model: 'small-judge', route: 'test-local', usage };
}
function dataset(id: string) {
  return resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id,
    checks: [{ id: 'prose', eval: 'llm-rubric', input: 'artifact:article', judge: 'editor',
      rubric: { prompt: 'Is the article direct?' }, minimum: 0.8 }],
    records: [{ id, group: id, input: { prompt: `Write the ${id} article.` }, outputs: { article: 'article.txt' } }],
  })), { registry: { judges: { editor: { version: 'fixture-route-v1' } } } });
}
async function fixture(judge: InferenceProvider) {
  const root = await mkdtemp(join(tmpdir(), 'paideia-route-training-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), 'Write the assigned article.');
  const baseline = await snapshotCandidate({ sourceRoot: source, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: 'whole-file' }] });
  const storeRoot = join(root, 'store'), store = await openExperimentStore(storeRoot);
  const starts = vi.fn(), writes = vi.fn(), stops = vi.fn();
  const progress: { type: string; payload: unknown }[] = [];
  const options: TrainingOptions = {
    id: 'routed-training', baseline, train: dataset('train'), validation: dataset('validation'), test: dataset('sealed'),
    native: { store, storeRoot, root: join(root, 'trials'), model: 'subject', timeoutMs: 2_000,
      registry: createEvaluationRegistry(), evaluation: { judges: { editor: { provider: judge, model: 'judge-policy' } },
        embeddings: {}, readText: async () => '' },
      adapter: { id: 'file-writer', capabilities: { toolTrace: 'none', liveObservations: false, cancellation: 'native-handle',
        multiTurn: false, resources: ['instructions'], isolation: 'test fixture', readIsolation: 'declared-paths', protectedPaths: true },
      async start(input) {
        starts(input.trialId);
        return {
          async run() {
            await writeFile(join(input.workspacePath, 'article.txt'), article); writes(input.trialId);
            return { status: 'completed', text: '', usage,
              coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
          },
          async stop(reason) {
            stops(input.trialId);
            return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test stopped' };
          },
        };
      } } },
    inference: { provider: provider('unused-optimizer', async () => { throw new Error('No proposal in this fixture'); }, 'subscription'), model: 'unused' },
    bridge: { command: 'unused-test-bridge', cwd: root, timeoutMs: 2_000 }, budget: { maxMetricCalls: 4, maxProposals: 1 },
    onProgress: async event => { progress.push(structuredClone(event)); },
  };
  return { options, starts, writes, stops, progress };
}
function baselineOptimizer(onMetric?: (result: Awaited<ReturnType<optimization.DspyOptimizationOptions['evaluate']>>, split: string) => void) {
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    const captures = [];
    let validationScore = 0;
    for (const split of ['train', 'validation'] as const) {
      const response = await request.evaluate({ caseId: split, split, components: request.components }, request.signal ?? new AbortController().signal);
      onMetric?.(response, split);
      if (split === 'validation') validationScore = response.score;
      captures.push({ caseId: split, split, captureId: response.captureId });
    }
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: request.components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 2, proposals: 0,
        selectedCandidateIndex: 0, candidates: [{ components: request.components, parents: [null], validationScore, discoveryEvaluations: 0 }],
        captures, generations: [] } };
  });
}

it('recovers judge quota within each stored trial, without rewriting articles or exposing sealed feedback', async () => {
  const attempts: InferenceAttempt[] = [];
  const primary = vi.fn<InferenceProvider['generate']>(async () => { throw new InferenceFailure('quota', 'test quota'); });
  const fallback = vi.fn<InferenceProvider['generate']>(async request => {
    expect(request.model).toBe('small-judge'); return judgment();
  });
  const judge = createRoutedInference({ id: 'fixed-policy', maxAttempts: 2, timeoutMs: 1_000,
    routes: [{ provider: provider('first', primary, 'subscription'), model: 'primary-model' }, { provider: provider('second', fallback), model: 'small-judge' }],
    observeAttempt: async attempt => { attempts.push(structuredClone(attempt)); } });
  const { options, starts, writes, progress } = await fixture(judge);
  baselineOptimizer((response, split) => {
    expect(response.score).toBe(1);
    if (split === 'train') expect(response.output).toContain(article);
    else expect(response).toMatchObject({ output: '', feedback: '' });
    expect(JSON.stringify(response)).not.toContain('Write the sealed article.');
  });
  const report = await trainAgent(options);
  expect(report.trials.map(trial => trial.phase)).toEqual(['train', 'validation', 'test']);
  expect(starts).toHaveBeenCalledTimes(3); expect(writes).toHaveBeenCalledTimes(3);
  expect(primary).toHaveBeenCalledTimes(3); expect(fallback).toHaveBeenCalledTimes(3);
  expect(attempts.map(attempt => [attempt.providerId, attempt.outcome])).toEqual([
    ['first', 'failed'], ['second', 'completed'], ['first', 'failed'], ['second', 'completed'], ['first', 'failed'], ['second', 'completed'],
  ]);
  expect(report.heldOut[0]!.meanScore).toBe(1);
  for (const trial of report.trials) {
    expect(await readFile(join(trial.paths.workspace, 'article.txt'), 'utf8')).toBe(article);
    const replay = await options.native.store.readReplay(trial.id, { audience: 'operator', phase: 'replay', releaseTestResults: true, frozenCandidateIds: [report.selected.id] });
    expect(replay.evaluations).toHaveLength(1);
    expect(replay.evaluations[0]!.report).toMatchObject({ schema: 'paideia.trial.v1', id: trial.id, status: 'pass' });
  }
  await expect(options.native.store.readReplay(report.trials[2]!.id, { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
  const freeze = progress.findIndex(event => event.type === 'selection.frozen');
  const sealed = progress.findIndex(event => event.type === 'trial.queued' && (event.payload as { phase: string }).phase === 'test');
  expect(sealed).toBeGreaterThan(freeze);
});

it('accepts a valid failing grade without querying a fallback or rerunning the subject', async () => {
  const fallback = vi.fn<InferenceProvider['generate']>(async () => judgment());
  const primary = vi.fn<InferenceProvider['generate']>(async () => judgment(0.4));
  const judge = createRoutedInference({ id: 'fixed-policy', maxAttempts: 2, timeoutMs: 1_000,
    routes: [{ provider: provider('strict', primary), model: 'strict-model' }, { provider: provider('lenient', fallback), model: 'lenient-model' }] });
  const { options, starts } = await fixture(judge);
  baselineOptimizer(response => { expect(response.score).toBe(0); });
  const report = await trainAgent(options);
  expect(report.trials.every(trial => trial.status === 'fail')).toBe(true);
  expect(report.heldOut[0]!.meanScore).toBe(0);
  expect(starts).toHaveBeenCalledTimes(3); expect(primary).toHaveBeenCalledTimes(3);
  expect(fallback).not.toHaveBeenCalled();
});

it('does not convert exhausted judge routes into a zero-quality observation or another native attempt', async () => {
  const unavailable = vi.fn<InferenceProvider['generate']>(async () => { throw new InferenceFailure('unavailable', 'test unavailable'); });
  const judge = createRoutedInference({ id: 'fixed-policy', maxAttempts: 1, timeoutMs: 1_000,
    routes: [{ provider: provider('offline', unavailable), model: 'small-judge' }] });
  const { options, starts, writes, progress } = await fixture(judge);
  baselineOptimizer();
  await expect(trainAgent(options)).rejects.toThrow('unscorable');
  expect(starts).toHaveBeenCalledTimes(1); expect(writes).toHaveBeenCalledTimes(1); expect(unavailable).toHaveBeenCalledTimes(1);
  const finished = progress.find(event => event.type === 'trial.finished')!.payload as { id: string };
  const replay = await options.native.store.readReplay(finished.id, { audience: 'operator', phase: 'replay' });
  expect(replay.evaluations[0]!.report).toMatchObject({ status: 'error', execution: 'completed', snapshot: { output: '' } });
  expect(progress.some(event => event.type === 'selection.frozen')).toBe(false);
});

it('propagates cancellation through the active judge and leaves no fallback or new trial', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const fallback = vi.fn<InferenceProvider['generate']>(async () => judgment());
  const primary = provider('waiting', async request => {
    request.signal!.addEventListener('abort', () => { cancelled = true; }, { once: true });
    controller.abort();
    return new Promise(() => undefined);
  });
  const judge = createRoutedInference({ id: 'fixed-policy', maxAttempts: 2, timeoutMs: 1_000,
    routes: [{ provider: primary, model: 'waiting-model' }, { provider: provider('fallback', fallback), model: 'small-judge' }] });
  const { options, starts, stops, progress } = await fixture(judge);
  options.signal = controller.signal;
  baselineOptimizer();
  await expect(trainAgent(options)).rejects.toThrow();
  expect(cancelled).toBe(true); expect(starts).toHaveBeenCalledTimes(1); expect(stops).toHaveBeenCalledTimes(1);
  expect(fallback).not.toHaveBeenCalled();
  expect(progress.some(event => event.type === 'selection.frozen')).toBe(false);
});

it('retains malformed judgments as unscorable protocol evidence instead of shopping for a passing judge', async () => {
  const fallback = vi.fn<InferenceProvider['generate']>(async () => judgment());
  const primary = vi.fn<InferenceProvider['generate']>(async () => ({ ...judgment(), text: 'not a judgment' }));
  const judge = createRoutedInference({ id: 'fixed-policy', maxAttempts: 2, timeoutMs: 1_000,
    routes: [{ provider: provider('malformed', primary), model: 'small-judge' }, { provider: provider('fallback', fallback), model: 'small-judge' }] });
  const { options, starts } = await fixture(judge);
  baselineOptimizer();
  await expect(trainAgent(options)).rejects.toThrow('unscorable');
  expect(starts).toHaveBeenCalledTimes(1); expect(primary).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
});

it('does not invoke any judge or rerun an agent that failed before producing the required article', async () => {
  const generate = vi.fn<InferenceProvider['generate']>(async () => judgment());
  const { options, progress } = await fixture(provider('unused-judge', generate));
  const start = vi.fn(async () => { throw new Error('Missing external fixture'); });
  options.native.adapter = { ...options.native.adapter, start };
  baselineOptimizer();
  await expect(trainAgent(options)).rejects.toThrow('infrastructure');
  expect(start).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
  expect(progress.some(event => event.type === 'selection.frozen')).toBe(false);
});

it.each(['quota', 'invalid-response'] as const)('resumes real DSPy after %s using a distinct rescore of the already-written article', async kind => {
  let failing = true;
  const judge = provider('stable-policy', async () => {
    if (failing) throw new InferenceFailure(kind, 'provider unavailable');
    return judgment();
  });
  const { options, starts, writes } = await fixture(judge);
  options.bridge = { command: join(process.cwd(), 'bridges/dspy/.venv/bin/paideia-dspy'),
    cwd: process.cwd(), timeoutMs: 10_000 };
  options.budget = { maxMetricCalls: 3, maxProposals: 1 };
  options.checkpoint = { directory: `${options.native.storeRoot}-checkpoint`, resume: false, identity: 'real-training-fixture' };
  await expect(trainAgent(options)).rejects.toThrow('unscorable');
  expect(starts).toHaveBeenCalledTimes(1);
  failing = false;
  options.checkpoint.resume = true;
  const report = await trainAgent(options);
  expect(starts).toHaveBeenCalledTimes(2);
  expect(writes).toHaveBeenCalledTimes(2);
  expect(report.trials).toHaveLength(2);
  expect(report.rescores).toHaveLength(1);
  expect(report.trials[0]!.status).toBe('error');
  expect(report.rescores![0]).toMatchObject({ schema: 'paideia.rescore.v1', runId: report.trials[0]!.id, status: 'pass' });
  expect(report.optimizer.provenance.captures).toEqual([{ caseId: 'validation', split: 'validation', captureId: report.trials[0]!.id }]);
  expect(report.heldOut[0]!.meanScore).toBe(1);
  const { recoverMeasurement } = await import('./recovery.js');
  const recovery = { options, dataset: options.validation!, report: report.trials[0]!, evaluation: options.native.evaluation,
    reserve: async (): Promise<string> => { throw new Error('must not reserve settled rescore'); } };
  expect((await recoverMeasurement({ ...recovery, pendingRescoreId: report.rescores![0]!.id }))!.id).toBe(report.rescores![0]!.id);
  await expect(recoverMeasurement({ ...recovery, pendingRescoreId: 'not-settled' })).rejects.toThrow('must not reserve');
  const failedGrade = { ...report.rescores![0]!, status: 'fail' as const };
  expect(await recoverMeasurement({ ...recovery, previous: failedGrade })).toBe(failedGrade);
  const error = Object.values(report.trials[0]!.evaluation.checks).find(check => check.status === 'error')!;
  const nested = { ...error, children: [error] };
  await expect(recoverMeasurement({ ...recovery, report: { ...report.trials[0]!, evaluation: {
    ...report.trials[0]!.evaluation, checks: { nested } } } })).rejects.toThrow('must not reserve');
  await expect(recoverMeasurement({ ...recovery, report: { ...report.trials[0]!, evaluation: {
    ...report.trials[0]!.evaluation, checks: { error: { ...error, judgeCalls: [] } } } } })).rejects.toThrow('classified');
  const again = await trainAgent(options);
  expect(again.optimizer).toEqual(report.optimizer);
  expect(starts).toHaveBeenCalledTimes(2);
  await expect(trainAgent({ ...options, checkpoint: { ...options.checkpoint, identity: 'changed-runtime' } })).rejects.toThrow('identity');
});

it('bounds recovery reservations cumulatively and cannot mutate a frozen selection or trust missing shutdown', async () => {
  const { TrainingCheckpoint } = await import('./checkpoint.js');
  const { recoverStoredReport, recoverMeasurement } = await import('./recovery.js');
  const { options } = await fixture(provider('judge', async () => judgment()));
  baselineOptimizer();
  const report = await trainAgent(options);
  options.checkpoint = { directory: `${options.native.storeRoot}-checkpoint`, resume: false, identity: 'guards', maxRecoveryAttempts: 1 };
  const checkpoint = (await TrainingCheckpoint.open(options, [options.train, options.test]))!;
  await checkpoint.begin('pending'); expect(checkpoint.reports).toHaveLength(0);
  await checkpoint.reserveRecovery(1);
  options.checkpoint.resume = true;
  const resumed = (await TrainingCheckpoint.open(options, [options.train, options.test]))!;
  await expect(resumed.reserveRecovery(1)).rejects.toThrow('budget');
  await expect(resumed.reserveRecovery(-1)).rejects.toThrow('budget');
  await resumed.freeze(report.optimizer);
  await expect(resumed.freeze({ ...report.optimizer, components: { changed: 'no' } })).rejects.toThrow('Frozen');
  const original = report.trials[0]!;
  await expect(recoverStoredReport(options, original.id, original.phase, 'another')).rejects.toThrow('shutdown');
  await expect(recoverStoredReport(options, original.id, original.phase, original.candidateId, { ...original, status: 'error' })).rejects.toThrow('differs');
  const input = { options, dataset: options.train, report: original, evaluation: options.native.evaluation, reserve: async () => 'reserved-id' };
  await expect(recoverMeasurement({ ...input, report: { ...original, status: 'error', execution: 'failed' } })).rejects.toThrow('incomplete');
  await expect(recoverMeasurement({ ...input, report: { ...original, status: 'unknown' } })).rejects.toThrow('missing evidence');
  await expect(recoverMeasurement({ ...input, report: { ...original, status: 'error' } })).rejects.toThrow('missing evidence');
  expect(await recoverMeasurement({ ...input, report: { ...original, status: 'fail' } })).toBeUndefined();
});
