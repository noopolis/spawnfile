import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { snapshotCandidate } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import * as evaluation from '../../evaluation/index.js';
import * as optimization from '../../optimization/index.js';
import { TrainingCheckpoint, trainingDigest } from './checkpoint.js';
import { retryTrial } from './retry.js';
import { trainAgent, type TrainingOptions } from './training.js';

const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function dataset(id: string, tokens: [string, string][]) {
  return resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id,
    checks: [{ id: 'shape', eval: 'contains-any', input: 'output.text', values: ['ack:'] }],
    records: tokens.map(([token, group]) => ({ id: token, group, input: { prompt: JSON.stringify({ token }) },
      checks: [{ id: 'answer', eval: 'equals', input: 'output.text', value: `ack:${token.toLowerCase()}` }] })),
  })));
}
async function fixture(editable = true): Promise<{ options: TrainingOptions; events: { type: string; payload: unknown }[]; source: string }> {
  const root = await mkdtemp(join(tmpdir(), 'paideia-train-test-')); cleanup.push(root);
  const source = join(root, 'source'); await mkdir(source);
  await writeFile(join(source, 'AGENTS.md'), 'Copy the input token unchanged.');
  const baseline = await snapshotCandidate({ sourceRoot: source, resources: [{ id: 'instructions', sourcePath: 'AGENTS.md',
    destinations: [{ kind: 'instructions', path: 'AGENTS.md' }], edit: editable ? 'whole-file' : 'locked' }] });
  const storeRoot = join(root, 'store'); const store = await openExperimentStore(storeRoot);
  const events: { type: string; payload: unknown }[] = [];
  const options: TrainingOptions = {
    id: 'training', baseline, train: dataset('train', [['Alpha', 'a'], ['Beta', 'b']]), test: dataset('test', [['Gamma', 'c']]),
    native: { store, storeRoot, root: join(root, 'trials'), model: 'test-model', timeoutMs: 2_000,
      registry: createEvaluationRegistry(), evaluation: { judges: {}, embeddings: {}, readText: async () => '' },
      adapter: { id: 'deterministic-test', capabilities: { toolTrace: 'none', liveObservations: true, cancellation: 'native-handle',
        multiTurn: false, resources: ['instructions'], isolation: 'test facade', readIsolation: 'declared-paths', protectedPaths: true },
      async start(input) { return {
        async run(turn) {
          const { token } = JSON.parse(turn.text) as { token: string };
          return { status: 'completed', text: input.instructions.includes('ack:') ? `ack:${token.toLowerCase()}` : token,
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: null, source: 'test' },
            coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
        },
        async stop(reason) { return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'test' }; },
      }; } } },
    inference: { model: 'test-optimizer', provider: { id: 'test', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      async generate() { return { text: 'reflection', model: 'test-optimizer', route: 'test', usage: null }; } } },
    bridge: { command: 'unused-by-unit-facade', cwd: root, timeoutMs: 2_000 }, budget: { maxMetricCalls: 6, maxProposals: 1 },
    onProgress: async event => { events.push(structuredClone(event)); },
  };
  return { options, events, source };
}

function optimizer(caseId = 'Alpha', split: 'train' | 'validation' = 'train') {
  vi.spyOn(optimization, 'readDspyCheckpointEvidence').mockResolvedValue({ generations: [], failedAttempts: [], reservations: [] });
  return vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    await request.evaluate({ caseId, split, components: request.components, round: 2 }, new AbortController().signal, 'callback');
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: request.components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
        evaluations: 1, proposals: 0, selectedCandidateIndex: 0,
        candidates: [{ components: request.components, parents: [null], validationScore: 1, discoveryEvaluations: 0 }], captures: [], generations: [] } };
  });
}
function native(options: TrainingOptions, failures: number, target = 'Alpha', deferred = false) {
  const counts = new Map<string, number>();
  const start = vi.spyOn(options.native.adapter, 'start').mockImplementation(async () => ({
    async run(turn) {
      const { token } = JSON.parse(turn.text) as { token: string };
      const count = (counts.get(token) ?? 0) + 1; counts.set(token, count);
      return { status: token === target && count <= failures ? 'failed' : 'completed',
        ...(deferred ? { blocked: 'awaiting-external-input' as const } : {}),
        text: token === target && count <= failures && !deferred ? '' : `ack:${token.toLowerCase()}`, error: token === target && count <= failures ? 'wake execution claim was lost' : undefined,
        usage: null, coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
    },
    async stop(reason) { return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'Test fixture closed' }; },
  }));
  return { counts, start };
}

it.each(['train', 'validation', 'test'] as const)('replaces one infrastructure failure in %s and retains both immutable reports', async phase => {
  const { options, events } = await fixture();
  options.trialRetries = 1;
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'retries', resume: false };
  options.slots = [{ index: 0, workerUid: 2200, roots: { workspace: '/isolated' }, ports: { base: 20000, count: 100 } }];
  const token = phase === 'train' ? 'Alpha' : phase === 'validation' ? 'Beta' : 'Gamma';
  const { counts, start } = native(options, 1, token);
  const run = optimizer(phase === 'test' ? 'Alpha' : token, phase === 'validation' ? 'validation' : 'train');
  const report = await trainAgent(options);
  expect(counts.get(token)).toBe(2);
  expect(report.trials).toHaveLength(3);
  expect(report.heldOut[0]!.meanScore).toBe(1);
  const failed = report.trials.find(trial => trial.execution === 'failed')!;
  const replacement = report.trials.find(trial => trial.id === report.retries![0]!.replacementTrialId)!;
  expect(report.retries).toEqual([{ failedTrialId: failed.id, replacementTrialId: replacement.id,
    cause: failed.error, attempt: 1 }]);
  expect(failed.error).toContain('wake execution claim was lost');
  expect(failed.failureKind).toBe('native-infrastructure');
  expect(replacement).not.toHaveProperty('failureKind');
  expect(replacement).toMatchObject({ phase, recordId: token, candidateId: failed.candidateId, execution: 'completed' });
  expect(replacement.round).toBe(failed.round);
  expect(start.mock.calls.every(([input]) => input.slot?.index === 0)).toBe(true);
  for (const trial of [failed, replacement]) {
    const replay = await options.native.store.readReplay(trial.id, { audience: 'evaluator', phase: phase === 'train' ? 'training' : phase,
      frozenCandidateIds: [options.baseline.id] });
    expect(replay.evaluations.some(entry => (entry.report as { id?: string }).id === trial.id)).toBe(true);
  }
  expect(events.filter(event => event.type === 'trial.retry')).toHaveLength(1);
  const calls = start.mock.calls.length;
  options.checkpoint.resume = true;
  const resumed = await trainAgent(options);
  expect(resumed.retries).toEqual(report.retries);
  expect(start).toHaveBeenCalledTimes(calls);
  expect(run).toHaveBeenCalledOnce(); // Frozen optimizer resume never calls native again.
});

it.each(['behavioral', 'malicious-output', 'collection', 'evaluation', 'historical'] as const)(
  'does not replace a failed execution caused by %s, including checkpoint resume', async kind => {
    const { options, events } = await fixture(); options.trialRetries = 3;
    options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: kind, resume: false };
    const record = options.train.records[0]!;
    if (kind === 'behavioral') record.live.checks = [
      { id: 'boundary', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'forbidden' } },
    ];
    if (kind === 'malicious-output') record.outputs = { article: 'article.json' };
    if (kind === 'collection') {
      let collections = 0;
      options.native.prepareEnvironment = async () => ({ collect: async () => {
        if (++collections === 1) throw new Error('collector unavailable');
        return {};
      } });
    }
    if (kind === 'historical') {
      const append = options.native.store.appendEvaluation;
      vi.spyOn(options.native.store, 'appendEvaluation').mockImplementation(async (id, evaluation, visibility) => {
        // Seed an immutable historical report; the current runner's report stays unchanged.
        const report = evaluation.report as import('../trials/index.js').TrialReport;
        await append(id, { ...evaluation, report: { ...report, failureKind: 'native-infrastructure' } }, visibility);
      });
    }
    const { counts } = native(options, 0);
    const start = options.native.adapter.start;
    options.native.adapter.start = async input => {
      const session = await start(input);
      return { ...session, run: async (turn, signal) => {
        const result = await session.run(turn, signal);
        if (kind === 'behavioral') {
          await input.onObservation({ id: 'forbidden', source: 'native', seq: 1, type: 'tool.dispatch',
            tool: 'forbidden', callId: 'call', args: {}, trialId: input.trialId, wakeId: turn.id,
            timestamp: '2026-10-15T00:00:00.000Z' });
          expect(signal?.aborted).toBe(true);
          throw new Error('regular adapter exception after decisive stop');
        }
        if (kind === 'malicious-output') await symlink('/etc/passwd', join(input.workspacePath, 'article.json'));
        if (kind === 'historical') {
          await input.onObservation({ id: 'acted', source: 'native', seq: 1, type: 'tool.dispatch',
            tool: 'file', callId: 'filing', trialId: input.trialId, wakeId: turn.id, timestamp: '2026-10-15T00:00:00.000Z' });
          return { ...result, status: 'failed' };
        }
        return result;
      } };
    };
    if (kind === 'evaluation') vi.spyOn(evaluation, 'evaluatePlan').mockRejectedValueOnce(new Error('evaluation unavailable'));
    optimizer();
    await expect(trainAgent(options)).rejects.toThrow();
    const report = events.find(event => event.type === 'trial.finished')!.payload as import('../trials/index.js').TrialReport;
    expect(report).toMatchObject({ execution: 'failed', failureKind: kind === 'behavioral' ? 'behavioral' : 'measurement',
      hostWork: 'settled', stop: { state: 'acknowledged', quiescence: 'confirmed' } });
    if (kind === 'behavioral') {
      expect(report.decisiveFailure).toMatchObject({ id: 'boundary', status: 'fail', finality: 'final' });
      expect(report.turns).toHaveLength(0);
    } else {
      expect(report.turns[0]!.native.status).toBe(kind === 'historical' ? 'failed' : 'completed');
      expect(report.snapshot.output).toBe('ack:alpha');
    }
    const retained = structuredClone(report);
    if (kind === 'historical') {
      retained.failureKind = 'native-infrastructure';
      const path = join(options.checkpoint!.directory, 'training.json');
      const saved = JSON.parse(await readFile(path, 'utf8'));
      Object.values(saved.state.entries).forEach(entry => { (entry as { report: unknown }).report = retained; });
      await writeFile(path, JSON.stringify({ state: saved.state, digest: trainingDigest(saved.state) }));
    }
    options.checkpoint.resume = true;
    await expect(trainAgent(options)).rejects.toThrow(/failed in infrastructure/);
    expect(counts.get('Alpha')).toBe(1);
    expect(events.filter(event => event.type === 'trial.retry')).toHaveLength(0);
    expect(events.find(event => event.type === 'trial.restored')!.payload).toEqual(retained);
  });

it('retries a closed native failure before terminal telemetry, retaining its missing-evidence receipt', async () => {
  const { options } = await fixture(); options.trialRetries = 1;
  const { counts } = native(options, 1);
  const start = options.native.adapter.start;
  options.native.adapter.start = async input => {
    const session = await start(input);
    let failed = false;
    return { ...session, run: async (turn, signal) => {
      const result = await session.run(turn, signal); failed = result.status === 'failed';
      return failed ? { ...result, text: '', coverage: [] } : result;
    }, stop: async reason => ({ ...await session.stop(reason), ...(failed ? { unevidenced: 'terminal-absent' as const } : {}) }) };
  };
  optimizer();
  const report = await trainAgent(options);
  expect(counts.get('Alpha')).toBe(2);
  expect(report.retries).toHaveLength(1);
  expect(report.trials[0]).toMatchObject({ execution: 'failed', failureKind: 'native-infrastructure',
    stop: { quiescence: 'confirmed', unevidenced: 'terminal-absent' }, snapshot: { events: [], output: '' } });
});

it.each([undefined, 0, 1, 3])('exhausts bound %s with the original infrastructure error and no zero score', async trialRetries => {
  const { options } = await fixture(); options.trialRetries = trialRetries;
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'exhausted', resume: false };
  const { counts } = native(options, 10); optimizer();
  await expect(trainAgent(options)).rejects.toThrow(/Trial .* failed in infrastructure/);
  expect(counts.get('Alpha')).toBe(1 + (trialRetries ?? 0));
  const saved = JSON.parse(await readFile(join(options.checkpoint.directory, 'training.json'), 'utf8'));
  expect(Object.values(saved.state.entries)).toHaveLength(1 + (trialRetries ?? 0));
  if (trialRetries) {
    options.checkpoint.resume = true;
    await expect(trainAgent(options)).rejects.toThrow(/failed in infrastructure/);
    expect(counts.get('Alpha')).toBe(1 + trialRetries);
  }
});

it.each(['behavioral', 'deferred', 'measurement'] as const)('never retries a %s failure', async kind => {
  const { options } = await fixture(); options.trialRetries = 3;
  const { counts } = native(options, kind === 'deferred' ? 1 : 0, 'Alpha', kind === 'deferred');
  const adapter = options.native.adapter.start;
  options.native.adapter.start = async input => {
    const handle = await adapter(input);
    return { ...handle, run: async (turn, signal) => {
      const result = await handle.run(turn, signal);
      return { ...result, text: kind === 'measurement' ? result.text : 'wrong answer' };
    } };
  };
  const run = optimizer();
  if (kind === 'measurement') {
    // A successfully captured execution with an errored measurement must not be repeated.
    options.train.records[0]!.effectiveStages[0]!.checks[0]!.eval = 'missing-evaluator';
    await expect(trainAgent(options)).rejects.toThrow();
  } else {
    const report = await trainAgent(options);
    expect(report.retries).toBeUndefined();
    expect(report.trials[0]).toMatchObject({ execution: kind === 'deferred' ? 'deferred' : 'completed', status: 'fail' });
  }
  expect(counts.get('Alpha')).toBe(1);
  expect(run).toHaveBeenCalledOnce();
});

it.each(['failed', 'replacement', 'unpublished'] as const)('resumes after %s publication without repeating a successful native capture', async point => {
  const { options } = await fixture(); options.trialRetries = 1;
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'resume-retry', resume: false };
  const { counts } = native(options, 1); optimizer();
  const progress = options.onProgress;
  options.onProgress = async event => {
    await progress?.(event);
    if (event.type === 'trial.finished') {
      const report = event.payload as { execution: string; recordId: string };
      if (report.recordId === 'Alpha' && (point === 'failed' ? report.execution === 'failed' : report.execution === 'completed')) {
        throw new Error('controlled crash');
      }
    }
  };
  await expect(trainAgent(options)).rejects.toThrow('controlled crash');
  const path = join(options.checkpoint.directory, 'training.json');
  if (point === 'unpublished') {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const replacement = Object.values(saved.state.entries).find(entry => (entry as { retry?: unknown }).retry) as { report?: unknown };
    delete replacement.report;
    await writeFile(path, JSON.stringify({ state: saved.state, digest: trainingDigest(saved.state) }));
  }
  options.onProgress = progress; options.checkpoint.resume = true;
  const report = await trainAgent(options);
  expect(counts.get('Alpha')).toBe(2);
  expect(report.trials.filter(trial => trial.recordId === 'Alpha')).toHaveLength(2);
  expect(report.retries).toHaveLength(1);
  expect(report.trials.find(trial => trial.id === report.retries![0]!.replacementTrialId)!.execution).toBe('completed');
});

it('keeps retries separate from held-out repeats and restores only missing samples', async () => {
  const { options } = await fixture(); options.trialRetries = 1; options.testRepeats = 3;
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'repeat-retry', resume: false };
  const { counts } = native(options, 1, 'Gamma'); optimizer();
  const progress = options.onProgress;
  options.onProgress = async event => {
    await progress?.(event);
    if (event.type === 'trial.finished' && (event.payload as { phase: string; execution: string }).phase === 'test'
      && (event.payload as { execution: string }).execution === 'completed') throw new Error('sealed crash');
  };
  await expect(trainAgent(options)).rejects.toThrow('sealed crash');
  options.onProgress = progress; options.checkpoint.resume = true;
  const report = await trainAgent(options);
  expect(counts.get('Gamma')).toBe(4); // Three independent samples plus one infrastructure failure.
  expect(report.heldOut[0]).toMatchObject({ meanScore: 1, trialScores: [1, 1, 1], standardError: 0 });
  expect(report.heldOut[0]!.trialIds).toHaveLength(3);
  expect(report.heldOut[0]!.trialIds).not.toContain(report.retries![0]!.failedTrialId);
});

it.each(['operator', 'deadline'])('stops before replacement on %s cancellation', async reason => {
  const { options } = await fixture(); options.trialRetries = 3;
  const controller = new AbortController(); options.signal = controller.signal;
  const { counts } = native(options, 1); optimizer();
  const progress = options.onProgress;
  options.onProgress = async event => {
    await progress?.(event);
    if (event.type === 'trial.finished') controller.abort(new Error(reason));
  };
  await expect(trainAgent(options)).rejects.toThrow(reason);
  expect(counts.get('Alpha')).toBe(1);
});

it('binds nondefault retries while omitted and explicit zero checkpoint bytes match', async () => {
  const { options } = await fixture();
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'identity', resume: false };
  const datasets = [options.train, options.test];
  await TrainingCheckpoint.open(options, datasets);
  const path = join(options.checkpoint.directory, 'training.json');
  const original = await readFile(path, 'utf8');
  options.checkpoint.resume = true; options.trialRetries = 0;
  await expect(TrainingCheckpoint.open(options, datasets)).resolves.toBeDefined();
  expect(await readFile(path, 'utf8')).toBe(original);
  options.trialRetries = 1;
  await expect(TrainingCheckpoint.open(options, datasets)).rejects.toThrow('identity');
});

it.each(['host', 'stop', 'quiescence', 'interrupted', 'legacy'])('does not replace unsafe, interrupted or unclassified native work: %s', async kind => {
  const { options } = await fixture(); optimizer(); native(options, 0);
  const report = (await trainAgent(options)).trials[0]!;
  report.snapshot = { ...report.snapshot, events: [], output: '', artifacts: {}, subjectUsage: undefined };
  report.turns = [];
  report.execution = kind === 'interrupted' ? 'interrupted' : 'failed';
  if (kind !== 'legacy') report.failureKind = 'native-infrastructure';
  if (kind === 'host') report.hostWork = 'incomplete';
  if (kind === 'stop') report.stop = undefined;
  if (kind === 'quiescence') report.stop = { ...report.stop!, quiescence: 'unknown' };
  const execute = vi.fn().mockResolvedValue(report);
  expect(await retryTrial({ key: 'unsafe', maximum: 3, execute })).toBe(report);
  expect(execute).toHaveBeenCalledOnce();
});

it('does not replace a deferred native result whose collection failed afterwards', async () => {
  const { options, events } = await fixture(); options.trialRetries = 3;
  let collections = 0;
  options.native.prepareEnvironment = async () => ({ collect: async () => {
    if (++collections === 1) throw new Error('collector unavailable');
    return {};
  } });
  const { counts } = native(options, 1, 'Alpha', true);
  optimizer();
  await expect(trainAgent(options)).rejects.toThrow();
  const report = events.find(event => event.type === 'trial.finished')!.payload as import('../trials/index.js').TrialReport;
  expect(report).toMatchObject({ execution: 'failed', failureKind: 'measurement' });
  expect(report.turns[0]!.native.blocked).toBe('awaiting-external-input');
  expect(counts.get('Alpha')).toBe(1);
  expect(events.filter(event => event.type === 'trial.retry')).toHaveLength(0);
});

it.each(['none', 'tool', 'artifact', 'deadline'] as const)('never replaces a cancelled wake after collection failure: %s', async evidence => {
  const { options, events } = await fixture(); options.trialRetries = 1;
  const { counts } = native(options, 1); optimizer();
  const start = options.native.adapter.start;
  let failed = false;
  options.native.adapter.start = async input => {
    const session = await start(input);
    return { ...session, run: async (turn, signal) => {
      const result = await session.run(turn, signal);
      failed = result.status === 'failed';
      if (!failed) return result;
      if (evidence === 'tool') await input.onObservation({ id: 'acted', source: 'native', seq: 1,
        type: 'tool.dispatch', tool: 'file', callId: 'filing', trialId: input.trialId, wakeId: turn.id,
        timestamp: '2026-10-15T00:00:00.000Z' });
      if (evidence === 'artifact') await writeFile(join(input.workspacePath, 'filing.txt'), 'Filed');
      if (evidence === 'deadline') await new Promise(resolve => setTimeout(resolve, 1_100));
      return { ...result, status: 'cancelled', text: '', coverage: [] };
    }, stop: async reason => ({ ...await session.stop(reason), unevidenced: 'terminal-unbound' }) };
  };
  options.train.records[0]!.outputs = { filing: 'filing.txt' };
  if (evidence === 'deadline') options.native.timeoutMs = 1_000;
  options.native.prepareEnvironment = async () => ({ collect: async () => {
    if (failed) throw new Error('collection cannot bind terminal evidence');
    return {};
  } });
  await expect(trainAgent(options)).rejects.toThrow();
  const report = events.find(event => event.type === 'trial.finished')!.payload as import('../trials/index.js').TrialReport;
  expect(report).toMatchObject(evidence === 'deadline' ? { execution: 'interrupted' }
    : { execution: 'failed', failureKind: 'measurement' });
  if (evidence === 'deadline') expect(report).not.toHaveProperty('failureKind');
  expect(report.error).toContain('Final collection failed');
  expect(counts.get('Alpha')).toBe(1);
  expect(events.filter(event => event.type === 'trial.retry')).toHaveLength(0);
});
