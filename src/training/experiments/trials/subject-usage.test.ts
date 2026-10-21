import { expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { trialScore } from '../training/index.js';
import type { ObservationCoverage } from '../../contracts/execution.js';
import type { EvaluationSnapshot } from '../../contracts/evaluation.js';
import type { SubjectTurnResult, Usage } from '../../contracts/execution.js';
import { createEvaluationRegistry, result } from '../../evaluation/index.js';
import { complete, setup } from './fixture.js';
import { subjectUsageSnapshot } from './subject-usage.js';
import { runTrial } from './trial.js';

const usage: Usage = { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 20,
  cacheWrite5mInputTokens: 10, cacheWrite1hInputTokens: 10, outputTokens: 20, reasoningTokens: 5, source: 'returned-native-total' };
const native = (patch: Partial<SubjectTurnResult> = {}): SubjectTurnResult => ({ ...complete, usage,
  coverage: [...complete.coverage, { channel: 'usage', completeness: 'complete', ordering: 'source' }], ...patch });
const capture = (turns: SubjectTurnResult[], complete = true, expectedTurns = turns.length) => subjectUsageSnapshot(turns, { complete, expectedTurns });

it('sums only native returned input/output totals; cached and reasoning tokens remain subsets', () => {
  expect(capture([native()])).toEqual({ status: 'complete', settled: true, usage });
  expect(capture([native(), native()])).toEqual({ status: 'complete', settled: true, usage: {
    inputTokens: 200, cachedInputTokens: 80, cacheWriteInputTokens: 40, cacheWrite5mInputTokens: 20,
    cacheWrite1hInputTokens: 20, outputTokens: 40, reasoningTokens: 10, source: 'paideia.subject.returned-turn-totals.v1' } });
  expect(capture([native()], false).status).toBe('incomplete');
  expect(capture([native()], true, 2).status).toBe('incomplete');
  expect(capture([native()], true, 1.5).status).toBe('incomplete');
  expect(capture([], true, 0)).toEqual({ status: 'incomplete', usage: null });
});

it('unknown native totals remain unknown and absent cache fields never become zero', () => {
  const partial = { inputTokens: 100, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, source: 'partial' };
  expect(capture([native({ usage: partial })])).toEqual({ status: 'incomplete', settled: true, usage: partial });
  const known = { ...partial, outputTokens: 5 };
  expect(capture([native({ usage: known }), native({ usage: known })])).toEqual({ status: 'complete', settled: true, usage: {
    ...known, inputTokens: 200, outputTokens: 10, source: 'paideia.subject.returned-turn-totals.v1' } });
  expect(capture([native({ usage: partial }), native()]).usage).toMatchObject({ outputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null });
  expect(capture([native(), native({ usage: null })])).toEqual({ status: 'incomplete', usage: null });
});

it('failed, cancelled, partial and unconfirmed work never attests complete efficiency evidence', () => {
  for (const value of [native({ status: 'failed' }), native({ status: 'cancelled' }), native({ coverage: [] }),
    native({ coverage: [{ channel: 'usage', completeness: 'partial', ordering: 'source' }] }),
    native({ coverage: [...native().coverage, { channel: 'usage', completeness: 'partial', ordering: 'none' }] }),
    native({ stop: { state: 'acknowledged', quiescence: 'unknown', remoteWork: 'unknown', scope: 'native-handle', reason: 'closed', detail: '' } })]) {
    expect(capture([value]).status).toBe('incomplete');
  }
  expect(capture([native({ stop: { state: 'acknowledged', quiescence: 'confirmed', remoteWork: 'unknown', scope: 'native-handle', reason: 'closed', detail: '' } })]).status).toBe('complete');
});

it('rejects invalid native measurements, inconsistent subsets and overflow rather than rewarding them', () => {
  for (const patch of [{ inputTokens: -1 }, { inputTokens: NaN }, { outputTokens: Infinity }, { outputTokens: 1.5 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1 }, { inputTokens: Number.MAX_SAFE_INTEGER }, { source: '' },
    { cachedInputTokens: 101 }, { reasoningTokens: 21 }, { cacheWriteInputTokens: 80 }, { cacheWrite5mInputTokens: 21 },
    { cacheWriteInputTokens: -1 }, { cacheWrite1hInputTokens: Infinity }]) {
    expect(capture([native({ usage: { ...usage, ...patch } })])).toEqual({ status: 'incomplete', usage: null });
  }
  const large = native({ usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER - 100 } });
  expect(capture([large, large])).toEqual({ status: 'incomplete', usage: null });
});

it('live and per-turn evaluations cannot borrow later usage; final closure sums expected turns once', async () => {
  const snapshots: EvaluationSnapshot[] = [];
  const task = await setup(async (input, turn) => {
    await input.onObservation({ id: turn.id, seq: turn.id === 'first' ? 1 : 2, source: 'untyped-running-estimate',
      type: 'usage', usage: { ...usage, inputTokens: 1 }, trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
    return native({ usage: { ...usage, inputTokens: turn.id === 'first' ? 100 : 200 } });
  });
  task.options.registry = createEvaluationRegistry({ inspect: { definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: false, validate() {} },
    async evaluate(_check, context) { snapshots.push(structuredClone(context.snapshot)); return result('pass', 'captured'); } } });
  task.options.record.turns = ['first', 'second'].map(id => ({ id, input: { prompt: id }, checks: [{ id, eval: 'inspect' }] }));
  task.options.record.live.checks = [{ id: 'live', eval: 'inspect', on: 'event', on_fail: 'continue' }];
  task.options.record.effectiveStages = [{ id: 'final', checks: [{ id: 'final', eval: 'inspect' }] }];
  const report = await runTrial(task.options);
  expect(report.execution).toBe('completed');
  expect(report.expectedTurns).toBe(2);
  expect(report.snapshot.subjectUsage).toMatchObject({ status: 'complete', usage: { inputTokens: 300, outputTokens: 40 } });
  const turnStates = snapshots.filter(row => row.closed && row.events.length === 1);
  expect(turnStates.map(row => row.subjectUsage)).toEqual([
    { status: 'incomplete', usage }, { status: 'incomplete', usage: { ...usage, inputTokens: 200 } },
  ]);
  expect(snapshots.filter(row => !row.closed).every(row => row.subjectUsage?.status === 'incomplete')).toBe(true);
  expect(task.journal.filter(row => row.type === 'trial.completed').at(-1)?.payload).toMatchObject({ snapshot: { subjectUsage: report.snapshot.subjectUsage } });
});

it('failed work, a missing later turn and unknown shutdown retain totals without eligible efficiency evidence', async () => {
  const task = await setup(async () => native({ status: 'failed' }));
  task.options.record.turns = ['first', 'second'].map(id => ({ id, input: { prompt: id } }));
  const failed = await runTrial(task.options);
  expect(failed.turns).toHaveLength(1); expect(failed.snapshot.subjectUsage).toEqual({ status: 'incomplete', usage });
  const unknown = await setup(async () => native());
  const start = unknown.options.adapter.start;
  unknown.options.adapter.start = async input => ({ ...await start(input), stop: async reason => ({ state: 'unknown', scope: 'native-handle', quiescence: 'unknown', remoteWork: 'unknown', reason, detail: '' }) });
  expect((await runTrial(unknown.options)).snapshot.subjectUsage?.status).toBe('incomplete');
});

it('a real terminal judge outage preserves native totals for exact rescore without another subject turn', async () => {
  const { openExperimentStore } = await import('../../storage/index.js');
  const { rescoreStoredTrial } = await import('../replay/index.js');
  const { parseDatasetYaml, resolveDataset } = await import('../../cases/index.js');
  const { InferenceFailure } = await import('../../inference/index.js');
  let nativeCalls = 0;
  const task = await setup(async () => { nativeCalls++; return native(); });
  const stages = [{ id: 'writing', checks: [{ id: 'quality', eval: 'llm-rubric', input: 'output.text', judge: 'editor', rubric: { prompt: 'Assess clear writing.' }, minimum: 0.8 }] }];
  task.options.record.effectiveStages = stages;
  task.options.evaluation.judges = { editor: { model: 'test-judge', provider: {
    id: 'test-provider', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    async generate() { throw new InferenceFailure('unavailable', 'Judge temporarily unavailable'); },
  } } };
  const report = await runTrial(task.options);
  expect(report.status).toBe('error'); expect(report.execution).toBe('completed');
  expect(report.snapshot.subjectUsage).toEqual({ status: 'complete', settled: true, usage });
  const store = await openExperimentStore(task.options.root + '/capture');
  await store.createRun({ schema: 'paideia.run.v1', id: report.id, datasetId: 'suite', datasetRole: report.phase,
    candidateId: report.candidateId, planDigest: report.planDigest, recordId: report.recordId });
  await store.appendEvaluation(report.id, { id: 'original', report });
  const dataset = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: revised
checks: [{id: usage-observed, eval: equals, input: output.text, value: DONE}]
records: [{id: record, input: {prompt: must never execute}}]
`));
  let observed: EvaluationSnapshot['subjectUsage'];
  const registry = createEvaluationRegistry({ inspect: { definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: false, validate() {} },
    async evaluate(_check, context) { observed = context.snapshot.subjectUsage; return result('pass', 'Exact native capture'); } } });
  dataset.records[0]!.effectiveStages = [{ id: 'inspect', checks: [{ id: 'usage', eval: 'inspect' }] }];
  const rescored = await rescoreStoredTrial({ id: 'rescored', runId: report.id, store, access: { audience: 'evaluator', phase: 'replay' }, dataset, registry,
    evaluation: { judges: {}, embeddings: {}, readText: async () => { throw new Error('No text sidecars'); } } });
  expect(rescored.status).toBe('pass'); expect(observed).toEqual({ status: 'complete', settled: true, usage }); expect(nativeCalls).toBe(1);
});

it('failure during terminal grading does not overwrite the already closed subject measurement', async () => {
  const task = await setup(async () => native());
  const persist = task.options.persist;
  task.options.persist = async event => { if (event.type === 'evaluation.measurement') throw new Error('Evaluator reporting unavailable'); await persist(event); };
  // Persistence rejection intentionally refuses a final report; the pre-judge snapshot
  // remains observable to the actual evaluator before that separate failure.
  let captured: EvaluationSnapshot['subjectUsage'];
  task.options.registry = createEvaluationRegistry({ inspect: { definition: { version: '1', kind: 'mechanical', incremental: true, stopProof: false, validate() {} },
    async evaluate(_check, context) { captured = context.snapshot.subjectUsage; return result('pass', 'Closed native work'); } } });
  task.options.record.effectiveStages = [{ id: 'writing', checks: [{ id: 'inspect', eval: 'inspect' }] }];
  await expect(runTrial(task.options)).rejects.toThrow('persistence failed');
  expect(captured).toEqual({ status: 'complete', settled: true, usage });
});

it('carries runtime-reported notional USD once and refuses invalid values', () => {
  const priced = native({ usage: { ...usage, notionalUsd: 0.25 } });
  expect(capture([priced]).usage?.notionalUsd).toBe(0.25);
  expect(capture([priced, priced]).usage?.notionalUsd).toBe(0.5);
  expect(capture([priced, native()]).usage?.notionalUsd).toBeNull();
  expect(capture([native(), native()]).usage).not.toHaveProperty('notionalUsd');
  for (const notionalUsd of [-1, Number.NaN]) expect(capture([native({ usage: { ...usage, notionalUsd } })])).toEqual({ status: 'incomplete', usage: null });
});

const limitError = 'Native execution failed: Grok broker turn limit_exceeded (limit_reason timeout)';
const coverage: ObservationCoverage[] = [{ channel: 'tools', completeness: 'partial', ordering: 'none' },
  { channel: 'output', completeness: 'absent', ordering: 'none' }, { channel: 'usage', completeness: 'partial', ordering: 'source' }];
/** The run52 shape: the broker sealed the subject's own declared timeout on a closed execution. */
function limited(limit?: SubjectTurnResult['limit']): SubjectTurnResult {
  return { status: 'failed', text: '', error: limitError, coverage, ...(limit ? { limit } : {}),
    usage: { inputTokens: 1_110_819, cachedInputTokens: 792_704, outputTokens: 80_322, reasoningTokens: null, source: 'fixture' } };
}
function filing() {
  return resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: filing
stages:
  - id: accepted-filing
    checks:
      - {id: body, eval: contains-any, input: 'artifact:article#/body', values: [Filed]}
    score:
      linear: {body: 1}
    gate: {passed: body}
records:
  - id: record
    group: unique
    input: {prompt: file the assigned story}
    outputs: {article: article.json}
`)).records[0]!;
}

it('grades a declared-limit stop on what it left, labels the limit and keeps the experiment scoring', async () => {
  const task = await setup(async () => limited('timeout'));
  task.options.record = filing();
  const report = await runTrial(task.options);
  expect(report).toMatchObject({ execution: 'limit-exceeded', limit: 'timeout', hostWork: 'settled', error: limitError });
  expect(report).not.toHaveProperty('failureKind');
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  // The closed execution certifies the absence: the missing article fails its check.
  expect(report.snapshot.subjectUsage).toMatchObject({ status: 'incomplete', settled: true });
  expect(report.evaluation.stages[0]!.checks[0]!.status).toBe('fail');
  expect(report.status).toBe('fail');
  // A behavioural zero the optimizer learns from, never "failed in infrastructure".
  expect(trialScore(report)).toBe(0);
});

it('grades whatever artifact a limit-stopped subject did produce, and still never passes it', async () => {
  const task = await setup(async input => {
    await writeFile(join(input.workspacePath, 'article.json'), '{"body":"Filed"}');
    return limited('tokens');
  });
  task.options.record = filing();
  const report = await runTrial(task.options);
  expect(report).toMatchObject({ execution: 'limit-exceeded', limit: 'tokens' });
  expect(report.evaluation.stages[0]!.checks[0]!.status).toBe('pass');
  expect(report.status).toBe('fail');
  expect(trialScore(report)).toBe(0);
});

it('keeps an unconfirmed-closure or unlabelled limit failure an infrastructure error', async () => {
  const unconfirmed = await setup(async () => limited('timeout'));
  unconfirmed.options.record = filing();
  const base = unconfirmed.options.adapter;
  unconfirmed.options.adapter = { ...base, async start(input) {
    const session = await base.start(input);
    return { ...session, stop: async reason => ({ ...await session.stop(reason), quiescence: 'unknown' as const, unconfirmed: 'child-running' as const }) };
  } };
  const unproven = await runTrial(unconfirmed.options);
  expect(unproven.execution).toBe('failed');
  expect(unproven).not.toHaveProperty('limit');
  expect(unproven.error).toBe(`Native closure unproven (child-running); ${limitError}`);
  expect(unproven.evaluation.stages[0]!.checks[0]!.status).toBe('unknown');
  expect(() => trialScore(unproven)).toThrow('failed in infrastructure');

  // The same words without the adapter's sealed-limit label are not a declared-limit stop.
  const unlabelled = await setup(async () => limited());
  unlabelled.options.record = filing();
  const crashed = await runTrial(unlabelled.options);
  expect(crashed.execution).toBe('failed');
  expect(crashed.status).toBe('error');
  expect(() => trialScore(crashed)).toThrow('failed in infrastructure');
});
