import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { snapshotCandidate } from '../../candidates/index.js';
import { openExperimentStore } from '../../storage/index.js';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { createEvaluationRegistry } from '../../evaluation/index.js';
import * as optimization from '../../optimization/index.js';
import { slotPort } from '../index.js';
import { TrainingCheckpoint, trainingDigest } from './checkpoint.js';
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
it('runs fixed partitions, freezes selection, then compares fresh sealed baseline and candidate trials', async () => {
  const { options, events, source } = await fixture();
  const generate = options.inference.provider.generate;
  options.inference.provider.generate = async request => ({ ...await generate(request), modelBasis: 'requested-assumption' });
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    expect(request.trainCaseIds).toEqual(['Alpha']); expect(request.validationCaseIds).toEqual(['Beta']);
    expect(JSON.stringify(request)).not.toContain('Gamma');
    const signal = new AbortController().signal;
    await expect(Promise.resolve().then(() => request.validateComponents({ wrong: 'x' }, signal))).rejects.toThrow('component set');
    await expect(request.evaluate({ caseId: 'Gamma', split: 'train', components: { ...request.components } }, signal)).rejects.toThrow('not in train');
    const baseline = await request.evaluate({ caseId: 'Beta', split: 'validation', components: { ...request.components } }, signal);
    expect(baseline.score).toBe(0); expect(baseline.feedback).toBe(''); expect(baseline.output).toBe('');
    const training = await request.evaluate({ caseId: 'Alpha', split: 'train', components: { ...request.components } }, signal);
    expect(training.feedback).toContain('ack:alpha'); expect(training.output).toBe('Alpha');
    const components = { 'instructions#file': 'Reply with ack: and the lowercase input token.' };
    await request.validateComponents(components, signal);
    const improved = await request.evaluate({ caseId: 'Beta', split: 'validation', components }, signal);
    expect(improved.score).toBe(1); expect(improved.feedback).toBe('');
    expect((await request.generate({ purpose: 'reflection', messages: [{ role: 'system', content: 'Optimize declared instructions.' }, { role: 'user', content: 'reflect' }], options: {} }, signal)).text).toBe('reflection');
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 3, proposals: 1,
        selectedCandidateIndex: 1, candidates: [
          { components: { ...request.components }, parents: [null], validationScore: 0, discoveryEvaluations: 0 },
          { components, parents: [0], validationScore: 1, discoveryEvaluations: 3 }],
        captures: [ { caseId: 'Beta', split: 'validation', captureId: baseline.captureId },
          { caseId: 'Alpha', split: 'train', captureId: training.captureId }, { caseId: 'Beta', split: 'validation', captureId: improved.captureId } ], generations: [] } };
  });
  const report = await trainAgent(options);
  expect(report.durationMs).toBeGreaterThan(0);
  expect(report.heldOut.map(result => result.meanScore)).toEqual([0, 1]); expect(report.trials).toHaveLength(5);
  const frozen = events.findIndex(event => event.type === 'selection.frozen');
  const firstTest = events.findIndex(event => event.type === 'trial.queued' && (event.payload as { phase: string }).phase === 'test');
  expect(firstTest).toBeGreaterThan(frozen); expect(events.at(-1)!.type).toBe('training.completed');
  expect(events.find(event => event.type === 'optimizer.generation.completed')!.payload)
    .toMatchObject({ model: 'test-optimizer', modelBasis: 'requested-assumption' });
  expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('Copy the input token unchanged.');
  const test = report.trials.at(-1)!;
  await expect(options.native.store.readReplay(test.id, { audience: 'optimizer', phase: 'training' })).rejects.toThrow();
  expect((await options.native.store.readReplay(test.id, { audience: 'operator', phase: 'test', frozenCandidateIds: [report.selected.id] })).manifest.candidateId).toBe(report.selected.id);
});
it('rejects locked-only candidates, split drift and unscorable native failures', async () => {
  const locked = await fixture(false);
  await expect(trainAgent(locked.options)).rejects.toThrow('editable');
  const { options } = await fixture();
  await expect(trainAgent({ ...options, test: { ...options.test, sharedPlanDigest: 'changed' } })).rejects.toThrow('plan drift');
  options.validation = dataset('validation', [['Delta', 'd']]);
  options.native.adapter = { ...options.native.adapter, start: async () => { throw new Error('native infrastructure failed'); } };
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    await request.evaluate({ caseId: 'Delta', split: 'validation', components: { ...request.components } }, new AbortController().signal);
    throw new Error('must not continue');
  });
  await expect(trainAgent(options)).rejects.toThrow('infrastructure');
});

it('reports an attempted optimizer failure with unknown usage rather than a fabricated zero', async () => {
  const { options, events } = await fixture();
  options.inference.provider.generate = async () => { throw new Error('Quota exhausted'); };
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    await request.generate({ purpose: 'reflection', messages: [
      { role: 'system', content: 'Optimize instructions.' }, { role: 'user', content: 'Reflect.' },
    ], options: {} }, new AbortController().signal);
    throw new Error('Must not continue');
  });
  await expect(trainAgent(options)).rejects.toThrow('Quota exhausted');
  expect(events.filter(event => event.type.startsWith('optimizer.'))).toEqual([
    { type: 'optimizer.generation.started', payload: { attempt: 1 } },
    { type: 'optimizer.generation.failed', payload: { attempt: 1, requestedModel: 'test-optimizer', model: null,
      route: null, usage: null, outcome: 'generation-error' } },
  ]);
  expect(events.some(event => event.type === 'selection.frozen')).toBe(false);
});

it('overlaps four stored trials, holds a fifth through closure and collection, and checkpoints every completion', async () => {
  const { options } = await fixture();
  options.slots = Array.from({ length: 4 }, (_, index) => ({ index, workerUid: 2200 + index,
    roots: { workspace: `/isolated/${index}` }, ports: { base: 20000 + index * 100, count: 100 } }));
  options.checkpoint = { directory: join(options.bridge.cwd, 'checkpoint'), identity: 'parallel', resume: false };
  const gates = Array.from({ length: 5 }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  });
  const started: number[] = [], prepared = new Map<string, number>();
  const closed = new Set<number>();
  let fourthStarted!: () => void, fifthStarted!: () => void;
  let enteredClose!: () => void, enteredCollect!: () => void;
  const fourth = new Promise<void>(resolve => { fourthStarted = resolve; });
  const fifth = new Promise<void>(resolve => { fifthStarted = resolve; });
  const atClose = new Promise<void>(resolve => { enteredClose = resolve; });
  const atCollect = new Promise<void>(resolve => { enteredCollect = resolve; });
  let releaseClose!: () => void, releaseCollect!: () => void;
  const closing = new Promise<void>(resolve => { releaseClose = resolve; });
  const collecting = new Promise<void>(resolve => { releaseCollect = resolve; });
  options.native.prepareEnvironment = async (_paths, _signal, context) => {
    expect(context.slot).toEqual(options.slots!.find(slot => slot.index === context.slot?.index));
    const ordinal = prepared.size;
    prepared.set(context.id, ordinal);
    return { collect: async () => {
      if (ordinal === 2 && closed.has(ordinal)) { enteredCollect(); await collecting; }
      return {};
    } };
  };
  const start = options.native.adapter.start;
  options.native.adapter = { ...options.native.adapter, start: async input => {
    const ordinal = prepared.get(input.trialId)!;
    expect(input.slot).toBeDefined();
    const native = await start(input);
    return { run: async (turn, signal) => {
      started.push(ordinal);
      if (started.length === 4) fourthStarted();
      if (started.length === 5) fifthStarted();
      await gates[ordinal]?.promise;
      return native.run(turn, signal);
    }, stop: async reason => {
      if (ordinal === 2) { enteredClose(); await closing; }
      closed.add(ordinal);
      return native.stop(reason);
    } };
  } };
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    expect(request.concurrency).toBe(4);
    const calls = Array.from({ length: 5 }, (_, index) => request.evaluate({ caseId: 'Alpha', split: 'train',
      components: { ...request.components } }, new AbortController().signal, `parallel-${index}`));
    await fourth;
    expect(started).toHaveLength(4);
    gates[2]!.resolve();
    await atClose;
    expect(started).toHaveLength(4);
    releaseClose();
    await atCollect;
    expect(started).toHaveLength(4);
    releaseCollect();
    await fifth;
    expect(started).toHaveLength(5);
    gates[4]!.resolve(); gates[3]!.resolve(); gates[1]!.resolve(); gates[0]!.resolve();
    const results = await Promise.all(calls);
    expect(new Set(results.map(result => result.captureId)).size).toBe(5);
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components: { ...request.components },
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
        evaluations: 5, proposals: 0, selectedCandidateIndex: 0, candidates: [], captures: [], generations: [] } };
  });
  const report = await trainAgent(options);
  expect(report.trials).toHaveLength(6);
  const saved = JSON.parse(await readFile(join(options.checkpoint.directory, 'training.json'), 'utf8'));
  expect(Object.values(saved.state.entries)).toHaveLength(6);
  expect(new Set(Object.values(saved.state.entries).map(entry => (entry as { id: string }).id)).size).toBe(6);
});

it('refuses an unenforceable run-wide request cap instead of silently ignoring it', async () => {
  const { options } = await fixture();
  await expect(trainAgent({ ...options, maxRunRequests: 48 } as TrainingOptions)).rejects.toThrow('maxRunRequests cannot be enforced');
});

it('forwards population search and derives editable scope from the actual candidate', async () => {
  const { options } = await fixture();
  options.search = { variants: 2, keep: 1, rounds: 1, boundaries: ['Keep identifiers.'],
    selection: 'pareto', rewriteShare: 0.5, minChange: 0.08, hypothesisSimilarity: 0.6, patience: 1 };
  const run = vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    expect(request.search).toEqual(options.search);
    expect(request.editScope).toEqual({ 'instructions#file': 'whole-file' });
    throw new Error('verified forwarding');
  });
  await expect(trainAgent(options)).rejects.toThrow('verified forwarding');
  expect(run).toHaveBeenCalledOnce();
});

it('binds population search settings into the training checkpoint identity', async () => {
  const { options } = await fixture();
  options.search = { variants: 2, keep: 1, rounds: 1, selection: 'pareto', rewriteShare: 0.5,
    minChange: 0.08, hypothesisSimilarity: 0.6, patience: 1, boundaries: [] };
  options.checkpoint = { directory: join(options.native.storeRoot!, 'checkpoint'), resume: false, identity: 'frozen' };
  await TrainingCheckpoint.open(options, [options.train, options.test]);
  options.checkpoint.resume = true;
  expect(await TrainingCheckpoint.open(options, [options.train, options.test])).toBeDefined();
  options.search.minChange = 0.1;
  await expect(TrainingCheckpoint.open(options, [options.train, options.test])).rejects.toThrow('identity');
});

it('keeps the pre-population training checkpoint identity when search is absent', async () => {
  const { options } = await fixture();
  options.checkpoint = { directory: join(options.native.storeRoot!, 'checkpoint'), resume: false, identity: 'legacy' };
  const datasets = [options.train, options.test];
  await TrainingCheckpoint.open(options, datasets);
  const saved = JSON.parse(await readFile(join(options.checkpoint.directory, 'training.json'), 'utf8'));
  const legacyIdentity = trainingDigest({
    execution: options.checkpoint.identity, id: options.id, baseline: options.baseline, datasets,
    adapter: options.native.adapter.id, model: options.native.model, resources: options.native.resources,
    optimizer: { provider: options.inference.provider.id, model: options.inference.model },
    seed: options.seed ?? 0, budget: options.budget, proposal: options.proposal, maxRecoveryAttempts: 2,
    versions: ['dspy3.3.1', 'gepa0.1.4', 'training-checkpoint1'],
  });
  expect(saved.state.identity).toBe(legacyIdentity);
});

it('leases four slots for fresh sealed pairs only after selection freezes and never reselects from test scores', async () => {
  const { options, events } = await fixture();
  options.train = dataset('train', [['Alpha', 'a']]);
  options.validation = dataset('validation', [['Beta', 'b']]);
  options.test = dataset('test', [['Gamma', 'c'], ['Delta', 'd']]);
  options.slots = Array.from({ length: 4 }, (_, index) => ({ index, workerUid: 1000 + index,
    roots: { workspace: `/test/slots/${index}` }, ports: { base: 10000 + index * 100, count: 100 } }));
  options.concurrency = 4;
  const active = new Set<number>(), leased: number[] = [];
  let release!: () => void, peak = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const start = options.native.adapter.start;
  options.native.adapter.start = async input => {
    const handle = await start(input);
    return { ...handle, async run(turn) {
      const { token } = JSON.parse(turn.text) as { token: string };
      if (!['Gamma', 'Delta'].includes(token)) return handle.run(turn);
      expect(events.some(event => event.type === 'selection.frozen')).toBe(true);
      expect(input.slot).toBeDefined();
      expect(active.has(input.slot!.index)).toBe(false);
      active.add(input.slot!.index); leased.push(input.slot!.index); peak = Math.max(peak, active.size);
      if (active.size === 4) release();
      await gate;
      return { status: 'completed', text: input.instructions.includes('ack:') ? 'test failure' : `ack:${token.toLowerCase()}`,
        usage: null, coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] };
    }, async stop(reason) { const receipt = await handle.stop(reason); active.delete(input.slot!.index); return receipt; } };
  };
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    expect(request.trainCaseIds).toEqual(['Alpha']); expect(request.validationCaseIds).toEqual(['Beta']);
    expect(JSON.stringify(request)).not.toMatch(/Gamma|Delta/);
    const components = Object.fromEntries(Object.keys(request.components).map(id => [id, 'Reply ack: plus the lowercase token.']));
    const signal = new AbortController().signal;
    for (const current of [request.components, components]) {
      await request.evaluate({ caseId: 'Alpha', split: 'train', components: current }, signal);
      const result = await request.evaluate({ caseId: 'Beta', split: 'validation', components: current }, signal);
      expect(result.feedback).toBe(''); expect(result.output).toBe('');
    }
    return { schema: 'paideia.dspy.v2', kind: 'result', id: request.id, components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0,
        evaluations: 4, proposals: 1, selectedCandidateIndex: 1, candidates: [], captures: [], generations: [] } };
  });
  const trained = await trainAgent(options);
  expect(peak).toBe(4); expect(new Set(leased).size).toBe(4); expect(active.size).toBe(0);
  expect(trained.selected.id).not.toBe(options.baseline.id);
  expect(trained.heldOut.map(row => row.meanScore)).toEqual([1, 0]);
  expect(trained.trials.filter(row => row.phase === 'test')).toHaveLength(4);
  expect(new Set(trained.trials.map(row => row.id)).size).toBe(trained.trials.length);
  expect(events.filter(event => event.type === 'selection.frozen')).toHaveLength(1);
});

it('binds held-out repeat counts to checkpoint identity while preserving omitted and explicit one', async () => {
  const { options } = await fixture();
  options.checkpoint = { directory: join(options.bridge.cwd, 'repeat-checkpoint'), identity: 'repeats', resume: false };
  await TrainingCheckpoint.open(options, [options.train, options.test]);
  options.checkpoint.resume = true; options.testRepeats = 1;
  expect(await TrainingCheckpoint.open(options, [options.train, options.test])).toBeDefined();
  options.testRepeats = 3;
  await expect(TrainingCheckpoint.open(options, [options.train, options.test])).rejects.toThrow('identity');
});

it('binds opt-in deferred rewards into checkpoint identity while zero retains the legacy identity', async () => {
  const { options } = await fixture();
  const datasets = [options.train, options.test];
  options.checkpoint = { directory: join(options.bridge.cwd, 'scoring-checkpoint'), identity: 'scoring', resume: false };
  await TrainingCheckpoint.open(options, datasets);
  options.checkpoint.resume = true;
  await expect(TrainingCheckpoint.open({ ...options, scoring: { deferred: 'zero' } }, datasets)).resolves.toBeDefined();
  await expect(TrainingCheckpoint.open({ ...options, scoring: { deferred: 'stage-score' } }, datasets)).rejects.toThrow('identity');
});

it.each([false, true])('recovers a persisted deferral-only stage score from a populated checkpoint (cached report: %s)', async cached => {
  const { options, events } = await fixture();
  options.train = resolveDataset(parseDatasetYaml(stringify({ schema: 'paideia.dataset.v1', id: 'deferred',
    stages: [{ id: 'quality', checks: [
      { id: 'ready', eval: 'equals', input: 'output.text', value: 'ready' },
      { id: 'perfect', eval: 'equals', input: 'output.text', value: 'perfect' },
    ], gate: { passed: 'ready' }, score: { linear: { ready: 1, perfect: 1 } } }],
    records: ['Alpha', 'Beta'].map(id => ({ id, group: id, input: { prompt: 'Write' } })),
  })));
  options.test = { ...options.train, id: 'test', records: [{ ...options.train.records[0]!, id: 'Gamma', group: 'Gamma' }] };
  options.scoring = { deferred: 'stage-score' };
  options.checkpoint = { directory: join(options.bridge.cwd, 'deferred-checkpoint'), identity: 'deferred', resume: false };
  const start = vi.spyOn(options.native.adapter, 'start').mockResolvedValue({
    run: async () => ({ status: 'failed', blocked: 'awaiting-external-input', text: 'ready', usage: null,
      coverage: [{ channel: 'output', completeness: 'complete', ordering: 'source' }] }),
    stop: async reason => ({ state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed',
      remoteWork: 'unknown', reason, detail: 'closed deferred fixture' }),
  });
  const measured: { score: number; captureId: string }[] = [];
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    measured.push(await request.evaluate({ caseId: 'Alpha', split: 'train', components: request.components },
      new AbortController().signal, 'deferred-callback'));
    throw new Error('Simulated optimizer interruption after durable capture');
  });
  await expect(trainAgent(options)).rejects.toThrow('Simulated optimizer interruption');
  expect(measured[0]!.score).toBe(0.5);
  const path = join(options.checkpoint.directory, 'training.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.state.entries['deferred-callback'].report).toMatchObject({
    execution: 'deferred', status: 'fail', preDeferralStatus: 'pass',
  });
  if (!cached) {
    delete saved.state.entries['deferred-callback'].report;
    await writeFile(path, JSON.stringify({ state: saved.state, digest: trainingDigest(saved.state) }));
  }
  options.checkpoint.resume = true;
  await expect(trainAgent(options)).rejects.toThrow('Simulated optimizer interruption');
  expect(measured).toHaveLength(2);
  expect(measured[1]).toMatchObject({ score: 0.5, captureId: measured[0]!.captureId });
  expect(start).toHaveBeenCalledOnce();
  expect(events.filter(event => event.type === 'trial.reused')).toHaveLength(1);
  const restored = JSON.parse(await readFile(path, 'utf8'));
  expect(restored.state.entries['deferred-callback'].report.preDeferralStatus).toBe('pass');
});

it.each([1, 2])('resolves preparation ports through real training with %i provisioned ports', async count => {
  const { options } = await fixture();
  options.slots = [{ index: 0, workerUid: 2200, roots: { workspace: '/isolated/0' }, ports: { base: 20000, count } }];
  let portFailure: unknown;
  const prepare = vi.fn<NonNullable<TrainingOptions['native']['prepareEnvironment']>>(async (_paths, _signal, context) => {
    expect(context.slot).toEqual(options.slots![0]);
    expect(context.slot).not.toBe(options.slots![0]);
    expect(slotPort(context.slot!, 0)).toBe(20000);
    try { expect(slotPort(context.slot!, 1)).toBe(20001); }
    catch (error) { portFailure = error; throw error; }
    return {};
  });
  options.native.prepareEnvironment = prepare;
  vi.spyOn(optimization, 'runDspyOptimization').mockImplementation(async request => {
    await request.evaluate({ caseId: 'Alpha', split: 'train', components: { ...request.components } }, new AbortController().signal);
    throw new Error('preparation verified');
  });
  // The quarantine names the slot and the preparation failure that left it unconfirmed.
  await expect(trainAgent(options)).rejects.toThrow(count === 1
    ? /all slots quarantined \(slot 0: trial \S+ hostWork=\S+ stop=\S+: .*Port index is outside the leased block/
    : /preparation verified/);
  expect(prepare).toHaveBeenCalledOnce();
  if (count === 1) expect(portFailure).toBeInstanceOf(RangeError);
  else expect(portFailure).toBeUndefined();
});
