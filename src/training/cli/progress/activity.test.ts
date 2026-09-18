import { expect, it } from 'vitest';
import type { EvaluationMeasurement } from '../../contracts/evaluation.js';
import { createActivityTracker } from './activity.js';

it('projects persisted activity without tool payloads or judge text and resets per trial', () => {
  const tracker = createActivityTracker();
  expect(tracker.snapshot()).toBeUndefined();
  const emit = (type: string, payload: unknown, trialId = 'trial') => tracker.observe({
    trialId, caseId: 'case', phase: 'train', event: { type, payload },
  });
  emit('trial.started', {});
  expect(tracker.snapshot()?.status).toBe('Preparing');
  emit('observation', { type: 'tool.dispatch', callId: 'call', arguments: 'PRIVATE' });
  emit('observation', { type: 'output', text: 'PRIVATE' });
  emit('judge.attempt', { prompt: 'PRIVATE' });
  expect(tracker.snapshot()).toMatchObject({ toolCalls: 1, judgeCalls: 1, status: 'Evaluating' });
  const measurement: EvaluationMeasurement = { stageId: 'writing', criterionId: 'voice', kind: 'criterion',
    status: 'pass', score: 0.8, weight: 2, weightedContribution: 0.8 * 2 / 3 };
  emit('evaluation.measurement', { ...measurement, reason: 'PRIVATE' });
  emit('evaluation.measurement', { ...measurement, score: 0.9 });
  emit('evaluation.measurement', { ...measurement, stageId: 'review', weight: undefined, weightedContribution: undefined });
  expect(tracker.snapshot()?.measurements).toHaveLength(2);
  expect(tracker.snapshot()?.measurements[0]?.score).toBe(0.9);
  expect(tracker.snapshot()?.measurements[0]?.judgeFailure).toBeUndefined();
  // The live view has to show the named cause, not a bare `error` with no score.
  emit('evaluation.measurement', { ...measurement, criterionId: 'grounding', status: 'error', score: null,
    reason: 'PRIVATE', judgeFailure: { cause: 'grant-refused', judge: 'grounding', providerId: 'grok-broker-grant',
      requestedModel: 'grok-4.6', responseModel: null, responseRoute: null, kind: 'unavailable' } });
  const errored = tracker.snapshot()!.measurements.find(row => row.criterionId === 'grounding')!;
  expect(errored.judgeFailure).toMatchObject({ cause: 'grant-refused', judge: 'grounding' });
  expect(errored.weight).toBe(2);
  const copy = tracker.snapshot()!;
  copy.measurements.length = 0;
  expect(tracker.snapshot()?.measurements).toHaveLength(3);
  expect(JSON.stringify(tracker.snapshot())).not.toContain('PRIVATE');
  emit('turn.native-result', {});
  expect(tracker.snapshot()?.status).toBe('Agent turn complete');
  emit('trial.completed', {});
  expect(tracker.snapshot()?.status).toBe('Trial complete');
  emit('trial.started', {}, 'next');
  expect(tracker.snapshot()).toMatchObject({ trialId: 'next', measurements: [], toolCalls: 0, judgeCalls: 0 });
});

it('bounds retained measurements without mixing identities', () => {
  const tracker = createActivityTracker();
  for (let index = 0; index < 1002; index++) tracker.observe({ trialId: 'trial', caseId: 'case', phase: 'test',
    event: { type: 'evaluation.measurement', payload: { stageId: 'stage', criterionId: String(index),
      kind: 'gate', status: 'pass', score: 1 } } });
  expect(tracker.snapshot()?.measurements).toHaveLength(1000);
  expect(tracker.snapshot()?.measurements[0]?.criterionId).toBe('2');
});

it('counts receipt-only tools once and resets call identities per trial', () => {
  const tracker = createActivityTracker();
  const emit = (type: string, callId: unknown, trialId = 'one') => tracker.observe({ trialId, caseId: 'case', phase: 'train',
    event: { type: 'observation', payload: { type, callId, result: 'PRIVATE RECEIPT' } } });
  emit('tool.complete', 'receipt-only');
  emit('tool.complete', 'receipt-only');
  expect(tracker.snapshot()?.toolCalls).toBe(1);
  emit('tool.dispatch', 'paired');
  emit('tool.complete', 'paired');
  emit('tool.complete', 'paired');
  expect(tracker.snapshot()?.toolCalls).toBe(2);
  for (const missing of [undefined, null, '', 42]) emit('tool.complete', missing);
  expect(tracker.snapshot()?.toolCalls).toBe(2);
  expect(JSON.stringify(tracker.snapshot())).not.toContain('PRIVATE');
  emit('tool.complete', 'paired', 'next');
  expect(tracker.snapshot()).toMatchObject({ trialId: 'next', toolCalls: 1 });
});
