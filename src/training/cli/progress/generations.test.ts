import { expect, it } from 'vitest';
import type { DspyRestoredEvidence } from '../../optimization/index.js';
import { createGenerationTracker } from './generations.js';
import { summarizeCosts } from '../../experiments/index.js';

it('retains the requested model for a failure without inventing actual model or cost', () => {
  const tracker = createGenerationTracker();
  tracker.observe({ type: 'optimizer.generation.failed', payload: { attempt: 1, requestedModel: 'configured-alias' } });
  const report = summarizeCosts([], { subjectModel: 'subject', optimizerGenerations: tracker.snapshot() });
  expect(report.entries[0]).toMatchObject({ requestedModel: 'configured-alias', model: null, modelBasis: 'unknown', usage: null });
  expect(report.apiEquivalentUsd).toBeNull();
});

it('retains old receipts and counts only unresolved reservations as unknown costs', () => {
  const tracker = createGenerationTracker();
  const failed = { id: 'failed-call', ordinal: 1, providerId: 'subscription', requestedModel: 'model',
    responseModel: 'model', responseRoute: 'subscription', outcome: 'failed' as const, failureKind: 'quota' as const,
    startedAt: 'start', completedAt: 'end', usage: null };
  const evidence: DspyRestoredEvidence = {
    generations: [{ callbackId: 'call-1', model: 'model', route: 'subscription', usage: null }],
    failedAttempts: [failed], reservations: [
      { id: 'call-1', method: 'generate', attempts: 2, settledAttempts: 2, completed: true },
      { id: 'call-2', method: 'generate', attempts: 2, settledAttempts: 0, completed: false },
      { id: 'call-3', method: 'evaluate', attempts: 3, settledAttempts: 0, completed: false },
    ],
  };
  expect(tracker.observe({ type: 'optimizer.restored', payload: evidence })).toBe(true);
  expect(tracker.attempts()).toBe(4);
  expect(tracker.snapshot().map(row => row.outcome)).toEqual([
    'completed', 'generation-error', 'interrupted; usage unknown', 'interrupted; usage unknown',
  ]);
  tracker.observe({ type: 'optimizer.generation.started', payload: { attempt: 1 } });
  tracker.observe({ type: 'optimizer.generation.completed', payload: { attempt: 1, model: 'new', usage: null } });
  expect(tracker.snapshot()).toHaveLength(5);
  expect(tracker.attempts()).toBe(5);
  tracker.observe({ type: 'optimizer.restored', payload: { ...evidence, failedAttempts: [] } });
  expect(tracker.snapshot()).toHaveLength(4);
  expect(tracker.snapshot().some(row => row.model === 'new')).toBe(true);
  const detached = tracker.snapshot(); detached.length = 0;
  expect(tracker.snapshot()).toHaveLength(4);
});

it('marks current attempts interrupted and ignores unrelated progress', () => {
  const tracker = createGenerationTracker();
  expect(tracker.observe({ type: 'trial.finished', payload: {} })).toBe(false);
  expect(tracker.attempts()).toBe(0);
  tracker.observe({ type: 'optimizer.generation.failed', payload: { attempt: 1 } });
  tracker.observe({ type: 'optimizer.generation.started', payload: { attempt: 2 } });
  tracker.interrupt();
  expect(tracker.snapshot().map(row => row.outcome)).toEqual(['generation-error', 'interrupted; usage unknown']);
});
