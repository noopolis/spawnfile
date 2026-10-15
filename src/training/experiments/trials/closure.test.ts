import { expect, it, vi } from 'vitest';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { runTrial } from './trial.js';
import { complete, setup } from './fixture.js';
import { drainObservations } from './closure.js';
import * as observationClosure from './closure.js';
import * as evaluation from '../../evaluation/index.js';

it('bounds a source that continuously replaces its acknowledged tail', async () => {
  const stable = Promise.resolve();
  await expect(drainObservations(() => stable)).resolves.toBeUndefined();
  await expect(drainObservations(() => Promise.resolve())).rejects.toThrow('did not quiesce');
  vi.useFakeTimers();
  let resolve: (() => void) | undefined;
  const stalled = new Promise<void>(done => { resolve = done; });
  const rejected = expect(drainObservations(() => stalled, 100)).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(100); await rejected;
  resolve!(); await Promise.resolve();
  vi.useRealTimers();
});

it.each(['none', 'tool.dispatch', 'tool.complete', 'output', 'output-event', 'usage', 'usage-event',
  'completed', 'deferred', 'artifact', 'earlier-artifact', 'partial-artifacts', 'empty-artifact', 'diagnostic'])(
  'retains %s evidence across cancellation and failed collection', async evidence => {
    const task = await setup(async (input, turn) => {
      if (['tool.dispatch', 'tool.complete', 'output-event', 'usage-event', 'diagnostic'].includes(evidence)) {
        const type = evidence === 'output-event' ? 'output' : evidence === 'usage-event' ? 'usage' : evidence as 'tool.dispatch' | 'tool.complete' | 'diagnostic';
        await input.onObservation({ id: 'event', source: 'native', seq: 1, type, tool: 'file', callId: 'call',
          text: type === 'output' ? 'acted' : undefined, trialId: input.trialId, wakeId: turn.id,
          timestamp: '2026-10-15T00:00:00.000Z' });
      }
      if (['artifact', 'partial-artifacts', 'empty-artifact'].includes(evidence)) {
        await writeFile(join(input.workspacePath, 'filing.txt'), evidence === 'empty-artifact' ? '' : 'Filed');
        if (evidence === 'partial-artifacts') await symlink('/etc/passwd', join(input.workspacePath, 'unsafe.txt'));
      }
      return { ...complete, status: evidence === 'completed' ? 'completed' : 'cancelled',
        ...(evidence === 'deferred' ? { blocked: 'awaiting-external-input' as const } : {}),
        text: evidence === 'output' ? 'acted' : '', usage: evidence === 'usage' ? {
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, source: 'native',
        } : null };
    });
    let collections = 0;
    task.options.record.outputs = { filing: 'filing.txt', ...(evidence === 'partial-artifacts' ? { unsafe: 'unsafe.txt' } : {}) };
    task.options.prepare = async () => ({ instructions: 'fixture', collect: async () => {
      collections++;
      if (evidence === 'earlier-artifact' && collections === 1) return {
        filing: { name: 'filing', checkpointId: 'first', digest: 'digest', bytes: 'Filed', value: 'Filed', provenance: 'collector' },
      };
      throw new Error('collector unavailable');
    } });
    const report = await runTrial(task.options);
    expect(report).toMatchObject({ execution: 'failed', failureKind:
      ['none', 'empty-artifact', 'diagnostic'].includes(evidence) ? 'native-infrastructure' : 'measurement' });
    expect(report.error).toContain('Final collection failed');
  });

it.each(['operator', 'deadline'] as const)('preserves %s interruption through collection failure', async cause => {
  const abort = new AbortController();
  const task = await setup(async () => {
    if (cause === 'operator') abort.abort();
    else await new Promise(resolve => setTimeout(resolve, 20));
    return { ...complete, status: 'cancelled', text: '' };
  });
  task.options.signal = abort.signal;
  if (cause === 'deadline') task.options.timeoutMs = 5;
  task.options.prepare = async () => ({ instructions: 'fixture', collect: async () => { throw new Error('collector unavailable'); } });
  const report = await runTrial(task.options);
  expect(report).toMatchObject({ execution: 'interrupted', hostWork: 'settled' });
  expect(report).not.toHaveProperty('failureKind');
  expect(report.error).toContain('Final collection failed');
});

it.each(['operator', 'deadline'] as const)('honors late %s cancellation after an internal collection stop', async cause => {
  const abort = new AbortController();
  const task = await setup(async () => ({ ...complete, status: 'cancelled', text: '' }));
  task.options.signal = abort.signal;
  task.options.timeoutMs = 100;
  let collections = 0;
  task.options.prepare = async () => ({ instructions: 'fixture', collect: async () => {
    if (++collections > 1) {
      if (cause === 'operator') abort.abort();
      else await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw new Error('collector unavailable');
  } });
  const report = await runTrial(task.options);
  expect(collections).toBe(2);
  expect(report.execution).toBe('interrupted');
  expect(report).not.toHaveProperty('failureKind');
  expect(report.error).toContain('Final collection failed');
});

it.each(['observation', 'evaluation'] as const)('preserves interruption when final %s work throws', async site => {
  const abort = new AbortController();
  const task = await setup(async () => ({ ...complete, status: 'cancelled', text: '' }));
  task.options.signal = abort.signal;
  const fail = async () => { abort.abort(); throw new Error('finalizer unavailable'); };
  const spy = site === 'observation' ? vi.spyOn(observationClosure, 'drainObservations').mockImplementation(fail)
    : vi.spyOn(evaluation, 'evaluatePlan').mockImplementation(fail);
  try {
    const report = await runTrial(task.options);
    expect(report.execution).toBe('interrupted');
    expect(report).not.toHaveProperty('failureKind');
    expect(report.error).toContain(site === 'observation' ? 'Observation closure failed' : 'Final evaluation failed');
  } finally { spy.mockRestore(); }
});

it('reconciles operator cancellation during the final stop receipt after a failure', async () => {
  const abort = new AbortController();
  const task = await setup(async () => ({ ...complete, status: 'cancelled', text: '' }));
  task.options.signal = abort.signal;
  task.options.prepare = async () => ({ instructions: 'fixture', collect: async () => { throw new Error('collection failed'); } });
  const controlModule = await import('./control.js');
  const create = controlModule.trialControl;
  const spy = vi.spyOn(controlModule, 'trialControl').mockImplementation((...args) => {
    const control = create(...args);
    let receipts = 0;
    const receipt = control.receipt;
    control.receipt = async () => {
      if (++receipts === 2) abort.abort();
      return receipt();
    };
    return control;
  });
  try {
    const report = await runTrial(task.options);
    expect(report.execution).toBe('interrupted');
    expect(report).not.toHaveProperty('failureKind');
  } finally { spy.mockRestore(); }
});
