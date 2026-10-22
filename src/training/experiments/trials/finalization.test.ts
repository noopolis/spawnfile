import { afterEach, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDatasetYaml, resolveDataset } from '../../cases/index.js';
import { result, createEvaluationRegistry } from '../../evaluation/index.js';
import { trialScore } from '../training/index.js';
import { runTrial } from './trial.js';
import { complete, setup } from './fixture.js';
import type { ObservationCoverage, SubjectStart, SubjectTurnResult, Usage } from '../../contracts/execution.js';

afterEach(() => { vi.useRealTimers(); });

const blockedError = 'Native execution completed; delivery blocked awaiting external input';
const partial: ObservationCoverage[] = [{ channel: 'tools', completeness: 'partial', ordering: 'none' },
  { channel: 'output', completeness: 'absent', ordering: 'none' },
  { channel: 'usage', completeness: 'complete', ordering: 'source' }];
const observed: ObservationCoverage[] = [{ channel: 'tools', completeness: 'complete', ordering: 'source' },
  ...partial.slice(1)];

/** The newsroom shape: one artifact the filing produces and the sequence that must produce it. */
function newsroom() {
  return resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: newsroom
stages:
  - id: accepted-article
    checks:
      - {id: filed, eval: tool-called, tool: mcp_newsroom_file_article}
      - {id: body, eval: contains-any, input: 'artifact:accepted-article#/body', values: [Filed]}
    score:
      linear: {filed: 0.5, body: 0.5}
    gate: {all: [{passed: filed}, {passed: body}]}
records:
  - id: record
    group: unique
    input: {prompt: file the assigned story}
    outputs: {accepted-article: article.json}
`)).records[0]!;
}

async function called(input: SubjectStart, turn: { id: string }, tool: string): Promise<void> {
  await input.onObservation({ id: tool, source: 'native', seq: 1, type: 'tool.complete', callId: `call-${tool}`,
    tool, trialId: input.trialId, wakeId: turn.id, success: true, timestamp: new Date().toISOString() });
}
/** Exactly what the observed foreman did: one delegating message, then the turn closed. */
const delegated = (input: SubjectStart, turn: { id: string }) => called(input, turn, 'moltnet_send');
function deferredTurn(coverage: ObservationCoverage[]): SubjectTurnResult {
  return { status: 'failed', blocked: 'awaiting-external-input', text: '', usage: null, error: blockedError, coverage };
}

/** The metered shape of the observed run: the turn closed and every token it spent is attributed. */
const metered: Usage = { inputTokens: 171_984, cachedInputTokens: 0, outputTokens: 2_048, reasoningTokens: 0, source: 'fixture' };
function closedTurn(coverage: ObservationCoverage[], status: SubjectTurnResult['status'] = 'completed'): SubjectTurnResult {
  return { status, text: '', usage: metered, coverage, ...(status === 'completed' ? {} : { error: 'native turn ended early' }) };
}
/** One required artifact and nothing else, so the trial's verdict is exactly its verdict. */
function filing() {
  return resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: filing
stages:
  - id: accepted-filing
    checks:
      - {id: body, eval: contains-any, input: 'artifact:accepted-article#/body', values: [Filed]}
    score:
      linear: {body: 1}
    gate: {passed: body}
records:
  - id: record
    group: unique
    input: {prompt: file the assigned story}
    outputs: {accepted-article: article.json}
`)).records[0]!;
}


it('closes every acquired native session on success, returned failure and failed turn gate', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const task = await setup(async () => ({ ...complete, status }));
    const report = await runTrial(task.options);
    expect(task.stops).toBe(1); expect(report.stop!.state).toBe('acknowledged');
  }
  const task = await setup();
  task.options.record.turns = [{ id: 'a', input: { prompt: 'first' }, checks: [{ eval: 'equals', input: 'output.text', value: 'wrong' }] }];
  await runTrial(task.options); expect(task.stops).toBe(1);
});

it('stops a native handle acquired after its start deadline has already ended', async () => {
  const task = await setup();
  let release!: () => void; let stops = 0;
  task.options.timeoutMs = 5;
  task.options.adapter = { ...task.options.adapter, start: async () => {
    await new Promise<void>(done => { release = done; });
    return { run: async () => complete, stop: async reason => {
      stops++; return { state: 'acknowledged', scope: 'native-handle', quiescence: 'confirmed', remoteWork: 'unknown', reason, detail: 'late handle closed' };
    } };
  } };
  const report = await runTrial(task.options);
  expect(report.hostWork).toBe('incomplete'); expect(report.execution).toBe('interrupted');
  expect(report.status).not.toBe('pass'); expect(stops).toBe(0);
  expect(report.stop!.state).toBe('unknown'); expect(report.stop!.remoteWork).toBe('unknown');
  release(); await vi.waitFor(() => expect(stops).toBe(1));
});

it('reconciles cancellation during final grading even when the evaluator returns a pass', async () => {
  const task = await setup(); const abort = new AbortController();
  task.options.signal = abort.signal;
  task.options.registry = createEvaluationRegistry({ delayed: {
    definition: { version: '1', kind: 'semantic', incremental: true, stopProof: false, validate() {} },
    evaluate: async () => { abort.abort(); await Promise.resolve(); return result('pass', 'ignored cancellation'); },
  } });
  task.options.record.effectiveStages = [{ id: 'grade', checks: [{ id: 'done', eval: 'delayed' }] }];
  const report = await runTrial(task.options);
  expect(report.execution).toBe('interrupted'); expect(report.status).toBe('error');
  expect(() => trialScore(report)).toThrow('incomplete');
});

it('does no terminal judge work after a selected decisive mechanical stop', async () => {
  let judgments = 0;
  const task = await setup(async (input, turn) => {
    await input.onObservation({ id: 'forbidden', source: 'native', seq: 1, type: 'tool.dispatch', tool: 'forbidden', callId: 'call', args: {},
      trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() });
    input.signal!.throwIfAborted(); return complete;
  });
  task.options.registry = createEvaluationRegistry({ judge: {
    definition: { version: '1', kind: 'semantic', incremental: true, stopProof: false, validate() {} },
    evaluate: async () => { judgments++; throw new Error('must not invoke final judge'); },
  } });
  task.options.record.effectiveStages = [{ id: 'grade', checks: [{ id: 'quality', eval: 'judge' }] }];
  task.options.record.live.checks = [{ id: 'boundary', on: 'event', on_fail: 'stop', not: { eval: 'tool-called', tool: 'forbidden' } }];
  const report = await runTrial(task.options);
  expect(judgments).toBe(0); expect(report.execution).toBe('interrupted'); expect(report.evaluation.status).toBe('skipped');
  expect(trialScore(report)).toBe(0);
});

it('freezes the capture when an observation persistence callback outlives the drain deadline', async () => {
  let release!: () => void; let callback!: Promise<void>;
  const task = await setup(async (input, turn) => {
    callback = Promise.resolve(input.onObservation({ id: 'late', source: 'native', seq: 1, type: 'output', text: 'MUTATED',
      trialId: input.trialId, wakeId: turn.id, timestamp: new Date().toISOString() }));
    void callback.catch(() => undefined);
    return complete;
  });
  task.options.timeoutMs = 5;
  task.options.record.live.checks = [{ id: 'observe', on: 'event', eval: 'equals', input: 'output.text', value: 'MUTATED', on_fail: 'continue' }];
  const persist = task.options.persist;
  task.options.persist = async event => {
    if (event.type === 'observation') await new Promise<void>(done => { release = done; });
    await persist(event);
  };
  const report = await runTrial(task.options);
  const frozen = JSON.stringify(report);
  expect(report.execution).toBe('interrupted'); expect(report.hostWork).toBe('incomplete');
  release(); await expect(callback).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(JSON.stringify(report)).toBe(frozen); expect(report.snapshot.events).toHaveLength(0);
  expect(task.journal.some(event => event.type === 'live.evaluation' && (event.payload as { boundary: string }).boundary === 'late')).toBe(false);
});

it('scores the trial, fails the accepted-article gate and never reports infrastructure failure', async () => {
  const task = await setup(async (input, turn) => { await delegated(input, turn); return deferredTurn(observed); });
  task.options.record = newsroom();
  const report = await runTrial(task.options);
  // The machine worked; the agent did not do the work.
  expect(report.execution).toBe('deferred');
  expect(report.hostWork).toBe('settled');
  expect(report.stop).toMatchObject({ state: 'acknowledged', quiescence: 'confirmed' });
  // The gate fails on the work that never happened, and it is a verdict, not an error.
  expect(report.evaluation.status).toBe('fail');
  const stage = report.evaluation.stages.find(row => row.id === 'accepted-article')!;
  expect(stage.gate.status).toBe('fail');
  expect(stage.checks.find(check => check.id === 'filed')!.status).toBe('fail');
  // The absent artifact stays missing: it neither passes nor becomes a measured zero,
  // and its weight remains in the denominator rather than being excluded from it.
  expect(stage.checks.find(check => check.id === 'body')!.status).toBe('unknown');
  expect(stage.score).toMatchObject({ missingWeight: 0.5, assessedWeight: 0.5, lower: 0 });
  // Deferred is never success, and the deferral is on the published report.
  expect(report.status).toBe('fail');
  expect(report.error).toBe(blockedError);
  expect(report.turns[0]!.native.blocked).toBe('awaiting-external-input');
  expect(trialScore(report)).toBe(0);
});

it('still scores when the native adapter can only claim partial tool coverage', async () => {
  const task = await setup(async (input, turn) => { await delegated(input, turn); return deferredTurn(partial); });
  task.options.record = newsroom();
  const report = await runTrial(task.options);
  // Every measured check is honestly unknown; the unanswered delivery is the failing witness.
  const stage = report.evaluation.stages.find(row => row.id === 'accepted-article')!;
  expect(stage.checks.map(check => check.status)).toEqual(['unknown', 'unknown']);
  expect(report.evaluation.status).toBe('unknown');
  expect(report.execution).toBe('deferred');
  expect(report.status).toBe('fail');
  expect(trialScore(report)).toBe(0);
});

it('never turns an unmeasurable evaluation into a behavioural zero', async () => {
  const task = await setup(async (input, turn) => {
    await delegated(input, turn);
    await writeFile(join(input.workspacePath, 'article.json'), '{"body":"Filed"}');
    return deferredTurn(observed);
  });
  task.options.record = resolveDataset(parseDatasetYaml(`schema: paideia.dataset.v1
id: newsroom-broken
checks:
- {id: body, eval: contains-any, input: 'artifact:accepted-article#not-a-pointer', values: [Filed]}
records:
- id: record
  group: unique
  input: {prompt: file the assigned story}
  outputs: {accepted-article: article.json}
`)).records[0]!;
  const report = await runTrial(task.options);
  expect(report.evaluation.status).toBe('error');
  expect(report.execution).toBe('deferred');
  expect(report.status).toBe('error');
  expect(() => trialScore(report)).toThrow('unscorable');
});

it('keeps an unproven, cancelled or plainly failed execution an infrastructure failure', async () => {
  // Same blocked marker, but the adapter cannot confirm closure: fail closed, as today.
  const unconfirmed = await setup(async (input, turn) => { await delegated(input, turn); return deferredTurn(observed); });
  unconfirmed.options.record = newsroom();
  const base = unconfirmed.options.adapter;
  unconfirmed.options.adapter = { ...base, async start(input) {
    const session = await base.start(input);
    return { ...session, stop: async reason => ({ ...await session.stop(reason), quiescence: 'unknown' as const }) };
  } };
  const unproven = await runTrial(unconfirmed.options);
  expect(unproven.execution).toBe('failed');
  expect(() => trialScore(unproven)).toThrow('infrastructure');

  // A hung or crashed turn carries no blocked marker at all.
  const crashed = await setup(async () => ({ status: 'failed', text: '', usage: null, coverage: partial,
    error: 'Native trial deadline exceeded' }));
  crashed.options.record = newsroom();
  const broken = await runTrial(crashed.options);
  expect(broken.execution).toBe('failed');
  expect(broken.status).toBe('error');
  expect(() => trialScore(broken)).toThrow('infrastructure');

  // An aborted turn is the machine's outcome even if the marker rides along.
  const aborted = await setup(async () => ({ ...deferredTurn(observed), status: 'cancelled' }));
  aborted.options.record = newsroom();
  const interrupted = await runTrial(aborted.options);
  expect(interrupted.execution).toBe('interrupted');
  expect(() => trialScore(interrupted)).toThrow('incomplete');
});

it('does not regress the disposed execution that really filed', async () => {
  const task = await setup(async (input, turn) => {
    await called(input, turn, 'mcp_newsroom_file_article');
    await writeFile(join(input.workspacePath, 'article.json'), '{"body":"Filed"}');
    return { status: 'completed', text: '', usage: null, coverage: observed };
  });
  task.options.record = newsroom();
  const report = await runTrial(task.options);
  expect(report.execution).toBe('completed');
  expect(report.status).toBe('pass');
  expect(report.turns[0]!.native.blocked).toBeUndefined();
  expect(trialScore(report)).toBe(1);
});

it('fails the required artifact the completed execution was observed never to produce', async () => {
  // The observed foreman: it delegated, closed its own turn, spent real tokens and filed nothing.
  const task = await setup(async (input, turn) => { await delegated(input, turn); return closedTurn(observed); });
  task.options.record = filing();
  const report = await runTrial(task.options);
  expect(report.execution).toBe('completed');
  expect(report.snapshot.subjectUsage!.status).toBe('complete');
  const stage = report.evaluation.stages.find(row => row.id === 'accepted-filing')!;
  const body = stage.checks.find(check => check.id === 'body')!;
  // The absence was observable, so it is a verdict, not missing evidence.
  expect(body.status).toBe('fail');
  expect(body.finality).toBe('final');
  expect(body.reason).toContain('Missing artifact:accepted-article#/body');
  // A failing check keeps its weight: measured at zero, never excluded from the denominator.
  expect(stage.score).toMatchObject({ assessedWeight: 1, missingWeight: 0, lower: 0, upper: 0 });
  expect(report.status).toBe('fail');
  expect(trialScore(report)).toBe(0);

  // A retried execution can leave the usage channel partial (a failed attempt with no ledger row is
  // not proof of no spend). The run is still closed, completed and stop-proven, so the absent
  // artifact is a verdict, while usage stays honestly incomplete.
  const retried = await setup(async (input, turn) => { await delegated(input, turn);
    return closedTurn([...observed.slice(0, 2), { channel: 'usage', completeness: 'partial', ordering: 'source' }]); });
  retried.options.record = filing();
  const partialUsage = await runTrial(retried.options);
  expect(partialUsage.execution).toBe('completed');
  expect(partialUsage.snapshot.subjectUsage).toMatchObject({ status: 'incomplete', settled: true });
  expect(partialUsage.evaluation.stages[0]!.checks[0]!.status).toBe('fail');
  expect(partialUsage.status).toBe('fail');
  expect(trialScore(partialUsage)).toBe(0);
});

it('keeps an execution that never closed an unmade observation rather than an observed absence', async () => {
  // Same missing artifact, same complete coverage, but the execution itself did not close.
  const cancelled = await setup(async (input, turn) => { await delegated(input, turn); return closedTurn(observed, 'cancelled'); });
  cancelled.options.record = filing();
  const interrupted = await runTrial(cancelled.options);
  expect(interrupted.execution).toBe('interrupted');
  expect(interrupted.evaluation.stages[0]!.checks[0]!.status).toBe('unknown');
  // The incomplete execution is its own error witness, so the trial never reports a verdict.
  expect(interrupted.status).toBe('error');
  expect(() => trialScore(interrupted)).toThrow('incomplete');

  const crashed = await setup(async (input, turn) => { await delegated(input, turn); return closedTurn(observed, 'failed'); });
  crashed.options.record = filing();
  const broken = await runTrial(crashed.options);
  expect(broken.execution).toBe('failed');
  expect(broken.evaluation.stages[0]!.checks[0]!.status).toBe('unknown');
  expect(() => trialScore(broken)).toThrow('infrastructure');

  // And the deferred path from the previous change is untouched: the artifact stays missing,
  // the unanswered delivery is what fails the trial, and the weight stays in the denominator.
  const deferred = await setup(async (input, turn) => { await delegated(input, turn); return deferredTurn(observed); });
  deferred.options.record = filing();
  const report = await runTrial(deferred.options);
  expect(report.execution).toBe('deferred');
  expect(report.evaluation.stages[0]!.checks[0]!.status).toBe('unknown');
  expect(report.evaluation.stages[0]!.score).toMatchObject({ assessedWeight: 0, missingWeight: 1 });
  expect(report.status).toBe('fail');
  expect(trialScore(report)).toBe(0);
});

it('leaves a produced artifact untouched by the observed-absence rule', async () => {
  const task = await setup(async (input, turn) => {
    await called(input, turn, 'mcp_newsroom_file_article');
    await writeFile(join(input.workspacePath, 'article.json'), '{"body":"Filed"}');
    return closedTurn(observed);
  });
  task.options.record = filing();
  const report = await runTrial(task.options);
  expect(report.snapshot.subjectUsage!.status).toBe('complete');
  expect(report.evaluation.stages[0]!.checks[0]!.status).toBe('pass');
  expect(report.status).toBe('pass');
  expect(trialScore(report)).toBe(1);
});
