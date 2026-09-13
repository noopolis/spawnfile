import { afterEach, expect, it, vi } from 'vitest';
import { result, createEvaluationRegistry } from '../../evaluation/index.js';
import { trialScore } from '../training/index.js';
import { runTrial } from './trial.js';
import { complete, setup } from './fixture.js';

afterEach(() => { vi.useRealTimers(); });

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
  expect(report.execution).toBe('failed'); expect(report.hostWork).toBe('incomplete');
  release(); await expect(callback).rejects.toThrow(); await new Promise(resolve => setTimeout(resolve, 10));
  expect(JSON.stringify(report)).toBe(frozen); expect(report.snapshot.events).toHaveLength(0);
  expect(task.journal.some(event => event.type === 'live.evaluation' && (event.payload as { boundary: string }).boundary === 'late')).toBe(false);
});
