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
    return { schema: 'paideia.dspy.v1', kind: 'result', id: request.id, components,
      provenance: { optimizer: 'dspy.GEPA', dspyVersion: '3.3.1', gepaVersion: '0.1.4', seed: 0, evaluations: 3, proposals: 1,
        selectedCandidateIndex: 1, candidates: [
          { components: { ...request.components }, parents: [null], validationScore: 0, discoveryEvaluations: 0 },
          { components, parents: [0], validationScore: 1, discoveryEvaluations: 3 }],
        captures: [ { caseId: 'Beta', split: 'validation', captureId: baseline.captureId },
          { caseId: 'Alpha', split: 'train', captureId: training.captureId }, { caseId: 'Beta', split: 'validation', captureId: improved.captureId } ], generations: [] } };
  });
  const report = await trainAgent(options);
  expect(report.heldOut.map(result => result.meanScore)).toEqual([0, 1]); expect(report.trials).toHaveLength(5);
  const frozen = events.findIndex(event => event.type === 'selection.frozen');
  const firstTest = events.findIndex(event => event.type === 'trial.queued' && (event.payload as { phase: string }).phase === 'test');
  expect(firstTest).toBeGreaterThan(frozen); expect(events.at(-1)!.type).toBe('training.completed');
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
