import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { result } from '../../evaluation/index.js';
import type { InferenceProvider } from '../../contracts/execution.js';
import { rescoreStoredTrial } from './index.js';
import { fixture } from './fixture.js';

test('appends a new immutable terminal evaluation without workspaces, native work or changes to original evidence', async () => {
  const { options, store, originalPath, report } = await fixture();
  const before = await readFile(originalPath);
  const source = (await store.readReplay('trial', options.access)).evaluations[0]!;
  const rescored = await rescoreStoredTrial(options);
  expect(rescored).toMatchObject({ schema: 'paideia.rescore.v1', scope: 'final-stages', status: 'pass', execution: 'completed',
    original: { evaluationId: 'original', digest: source.digest, status: 'fail', candidateId: 'candidate' },
    evaluation: { status: 'pass' }, criteria: { datasetId: 'revised-criteria', stages: options.dataset.records[0]!.effectiveStages } });
  expect(rescored.coverage).toEqual(report.snapshot.coverage);
  expect(rescored.notReevaluated).toEqual(['live', 'per-turn']);
  expect(await readFile(originalPath)).toEqual(before);
  const replay = await store.readReplay('trial', options.access);
  expect(replay.evaluations).toHaveLength(2);
  expect(replay.evaluations.find(entry => entry.id === 'rescore')!.report).toEqual(JSON.parse(JSON.stringify(rescored)));
  await expect(rescoreStoredTrial(options)).rejects.toThrow('already exists');
  expect((await store.readReplay('trial', { audience: 'viewer', phase: 'replay' })).evaluations).toEqual([]);
});

test('retains the selected mechanical stop when replacement criteria pass', async () => {
  const decisive = { ...result('fail', 'Forbidden tool dispatched'), id: 'never-search',
    children: [result('fail', 'Mechanical witness')], usage: [] };
  const { options, report } = await fixture(report => {
    report.execution = 'interrupted'; report.hostWork = 'incomplete'; report.decisiveFailure = decisive;
    report.error = 'Stopped at forbidden dispatch'; report.stop = { state: 'acknowledged', scope: 'process-group',
      quiescence: 'unknown', remoteWork: 'unknown', reason: 'mechanical stop', detail: 'Escaped effects unknown' };
  });
  const rescored = await rescoreStoredTrial(options);
  expect(rescored).toMatchObject({ execution: 'interrupted', hostWork: 'incomplete', status: 'fail', evaluation: { status: 'pass' },
    decisiveFailure: decisive, stop: report.stop, error: report.error, coverage: report.snapshot.coverage });
});

test('infrastructure failure, interruption and partial output cannot become a successful new run', async () => {
  for (const state of ['missing', 'unknown'] as const) {
    const { options } = await fixture(report => {
      if (state === 'missing') delete report.stop;
      else report.stop!.state = 'unknown';
    });
    expect(await rescoreStoredTrial(options)).toMatchObject({ status: 'error', execution: 'completed', evaluation: { status: 'pass' } });
  }
  for (const execution of ['failed', 'interrupted'] as const) {
    const { options } = await fixture(report => { report.execution = execution; });
    expect(await rescoreStoredTrial(options)).toMatchObject({ execution, status: 'error', evaluation: { status: 'pass' } });
  }
  const { options } = await fixture(report => { report.snapshot.coverage = [{ channel: 'output', completeness: 'partial', ordering: 'source' }]; });
  expect(await rescoreStoredTrial(options)).toMatchObject({ status: 'unknown', evaluation: { status: 'unknown' },
    coverage: [{ channel: 'output', completeness: 'partial' }] });
});

test('only explicit rescoring invokes its configured judge, with frozen criteria and the original snapshot', async () => {
  const { options, store } = await fixture();
  const generate = vi.fn<InferenceProvider['generate']>(async request => {
    expect(request.model).toBe('review-model');
    expect(request.prompt).toContain('ARTICLE'); expect(request.prompt).toContain('Original evidence');
    return { text: JSON.stringify({ score: 1, verdict: 'pass', reasons: ['Clear'], citations: [{ source: 'input', quote: 'ARTICLE' }] }),
      model: 'review-model', usage: { inputTokens: 4, cachedInputTokens: null, outputTokens: 1, reasoningTokens: null, source: 'fixture-judge' }, route: 'test' };
  });
  const judge: InferenceProvider = { id: 'test', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false }, generate };
  const yaml = `schema: paideia.dataset.v1
id: revised-criteria
checks: [{id: prose, eval: llm-rubric, input: output.text, evidence: 'input:files', judge: editor, rubric: {file: rubric.md}, minimum: 0.8}]
records: [{id: story, input: {prompt: Never execute}, context: {origin: new}}]
`;
  options.dataset = resolveDataset(parseDatasetYaml(yaml), { registry: { judges: { editor: { version: '1' } } }, readCriterionFile: () => 'Judge clear prose.' });
  options.evaluation = { judges: { editor: { provider: judge, model: 'review-model' } }, embeddings: {}, readText: async () => {
    options.evaluation.judges.editor!.model = 'changed-after-start';
    return 'Judge clear prose.';
  } };
  const rescored = await rescoreStoredTrial(options);
  expect(rescored.evaluation.stages[0]!.checks[0]!.usage).toEqual([expect.objectContaining({ source: 'fixture-judge', inputTokens: 4 })]);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(rescored.criteria.inferenceRoutes.judges.editor).toEqual({ providerId: 'test', model: 'review-model', citationRepairs: 0 });
  await store.readReplay('trial', options.access);
  expect(generate).toHaveBeenCalledTimes(1);
  await expect(rescoreStoredTrial({ ...options, id: 'changed', evaluation: { ...options.evaluation, readText: async () => 'Tampered rubric' } })).rejects.toThrow('Criterion sidecar changed');
  await expect(rescoreStoredTrial({ ...options, id: 'version', registry: {} })).rejects.toThrow('version drift');
  expect(generate).toHaveBeenCalledTimes(1);
});

test('rejects missing/duplicate records, per-turn checks, empty plans, invalid IDs and pre-cancellation', async () => {
  const { options } = await fixture();
  const record = options.dataset.records[0]!;
  for (const records of [[], [record, record]]) await expect(rescoreStoredTrial({ ...options, dataset: { ...options.dataset, records } })).rejects.toThrow('original record exactly once');
  await expect(rescoreStoredTrial({ ...options, dataset: { ...options.dataset, records: [{ ...record,
    turns: [{ id: 'step', input: { prompt: 'same turn' }, checks: [{ id: 'check', eval: 'contains-any', input: 'output.text', values: ['ARTICLE'] }] }] }] } })).rejects.toThrow('stored turn snapshots');
  await expect(rescoreStoredTrial({ ...options, dataset: { ...options.dataset, records: [{ ...record, effectiveStages: [] }] } })).rejects.toThrow('nonempty');
  for (const id of ['', 'x'.repeat(513), 'bad\0id']) await expect(rescoreStoredTrial({ ...options, id })).rejects.toThrow('valid immutable');
  await expect(rescoreStoredTrial({ ...options, signal: AbortSignal.abort() })).rejects.toThrow('cancelled');
  await expect(rescoreStoredTrial({ ...options, dataset: { ...options.dataset,
    criterionFileDigests: { 'unmapped.md': 'sha256:unavailable' } } })).rejects.toThrow('Unexpected sidecar read');
  await expect(rescoreStoredTrial({ ...options, id: 'turns-without-gates', dataset: { ...options.dataset, records: [{ ...record,
    turns: [{ id: 'step', input: { prompt: 'does not run' } }] }] } })).resolves.toMatchObject({ scope: 'final-stages' });
});

test('new dataset mutation during criterion loading cannot change the frozen evaluation plan', async () => {
  const { options } = await fixture();
  // Use an actually authenticated sidecar to introduce an async preparation boundary.
  options.dataset.criterionFileDigests['extra.md'] = `sha256:${createHash('sha256').update('fixed').digest('hex')}`;
  options.evaluation.readText = async () => {
    options.dataset.records[0]!.effectiveStages[0]!.checks[0]!.values = ['DIFFERENT'];
    return 'fixed';
  };
  expect(await rescoreStoredTrial(options)).toMatchObject({ status: 'pass' });
});

test('late cancellation cannot append a passing rescore when an evaluator ignores the signal', async () => {
  const { options, store } = await fixture();
  const controller = new AbortController();
  const evaluator = options.registry['contains-any']!;
  options.registry = { ...options.registry, 'contains-any': { ...evaluator, evaluate: async () => {
    controller.abort(); return result('pass', 'Returned after cancellation');
  } } };
  await expect(rescoreStoredTrial({ ...options, signal: controller.signal })).rejects.toThrow('cancelled during');
  expect((await store.readReplay('trial', options.access)).evaluations).toHaveLength(1);
});

test('retains the intended criteria when a caller-owned evaluator mutates its argument and records embedding routes', async () => {
  const { options } = await fixture();
  const evaluator = options.registry['contains-any']!;
  options.registry = { ...options.registry, 'contains-any': { ...evaluator, evaluate: async check => {
    check.values = ['mutated by evaluator']; return result('pass', 'Custom evaluation');
  } } };
  const embed = vi.fn(async () => ({ vectors: [], usage: null }));
  options.evaluation.embeddings = { local: { id: 'local-embedding', version: 'fixture-v1', embed } };
  const rescored = await rescoreStoredTrial(options);
  expect(rescored.criteria.stages[0]!.checks[0]!.values).toEqual(['ARTICLE']);
  expect(rescored.criteria.inferenceRoutes.embeddings.local).toEqual({ providerId: 'local-embedding', version: 'fixture-v1' });
  expect(embed).not.toHaveBeenCalled();
});
