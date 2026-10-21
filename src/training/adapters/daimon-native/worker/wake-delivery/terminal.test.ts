import { expect, test } from 'vitest';
import { activityFixture, receiptFixture, traceFixture } from '../../test-fixtures.js';
import type { NativeEvidence } from '../types.js';
import { validateTransportExecutions } from './terminal.js';
import { DeclaredLimitStop } from '../evidence/index.js';
import type { TransportEvidence } from './types.js';

function fixture() {
  const selectedDeliveries = ['first', 'second'].map(id => ({ deliveryId: id, executionIds: [id],
    receipt: { ...receiptFixture(), delivery_id: id, execution_id: id } }));
  const batches = selectedDeliveries.map(row => ({ executionId: row.deliveryId, deliveryIds: [row.deliveryId], observedAt: '2026-10-11T00:00:00Z' }));
  const evidence: TransportEvidence = { source: { kind: 'transport', deliveryIdPrefix: 'm:' }, deliveries: [],
    selectedDeliveries, batches, batch: batches[0], deferredDeliveryIds: [], unresolvedDeliveryIds: [], renderedAllowances: 'unavailable-public-api' };
  const native: NativeEvidence = { traces: selectedDeliveries.map(row => ({ ...traceFixture(), turn_id: row.deliveryId })),
    usage: selectedDeliveries.map(row => ({ v: 'noopolis.daimon.turn-usage.v1', engine: 'codex', agent: 'agent:writer', wake: row.deliveryId,
      input: 1, output: 1, total: 2, cache_read: 0, complete: true })), modelContexts: [], toolReceipts: [] };
  return { evidence, native };
}

test('a deferred revisit that settles another selected delivery still needs a batch and completed telemetry', () => {
  const { evidence, native } = fixture();
  evidence.selectedDeliveries![0]!.executionIds.push('second');
  evidence.batches![1]!.deliveryIds.push('first');
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).not.toThrow();
  native.traces[1]!.status = 'failed';
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow('Native execution failed');
});

test('missing evidence on a non-primary selection never passes on the first execution alone', () => {
  const corruptions: [(evidence: TransportEvidence, native: NativeEvidence) => void, string][] = [
    [e => { e.batch = undefined; }, 'batch membership'],
    [e => { e.selectedDeliveries = undefined; }, 'selection evidence'],
    [e => { e.selectedDeliveries = []; }, 'selection evidence'],
    [e => { e.selectedDeliveries![1]!.receipt = undefined; }, 'execution binding'],
    [e => { e.selectedDeliveries![1]!.executionIds = []; }, 'execution binding'],
    [e => { e.batches = undefined; }, 'batch membership'],
    [e => { e.batches!.pop(); }, 'batch membership'],
    [e => { e.batches![1]!.deliveryIds = ['foreign']; }, 'batch membership'],
    [(_e, n) => { n.traces.pop(); }, 'terminal telemetry'],
    [(_e, n) => { n.usage.pop(); }, 'token usage'],
    [(_e, n) => { n.traces[1]!.agent_id = 'foreign'; }, 'identity mismatch'],
    [(_e, n) => { n.traces.push(n.traces[1]!); }, 'more than once'],
  ];
  for (const [corrupt, message] of corruptions) {
    const { evidence, native } = fixture();
    corrupt(evidence, native);
    expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow(message);
  }
});

test.each(['failed', 'completed'] as const)('an unsampled %s execution cannot disappear behind a successful retry', status => {
  const { evidence, native } = fixture();
  native.traces.unshift({ ...traceFixture(), turn_id: 'between-polls', status });
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer'))
    .toThrow('terminal trace omitted execution ownership');
});

function retried() {
  const { evidence, native } = fixture();
  evidence.selectedDeliveries![0]!.executionIds = ['first-attempt', 'first'];
  evidence.batches!.unshift({ executionId: 'first-attempt', deliveryIds: ['first'], observedAt: '2026-10-11T00:00:00Z' });
  native.traces.unshift({ ...traceFixture(), turn_id: 'first-attempt', status: 'failed' });
  return { evidence, native };
}

test('a failed attempt followed by a completed Daimon retry settles the delivery and stays recorded', () => {
  const { evidence, native } = retried();
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).not.toThrow();
  expect(native.traces.find(row => row.turn_id === 'first-attempt')?.status).toBe('failed');
  expect(evidence.selectedDeliveries![0]!.executionIds).toContain('first-attempt');
});

test('a failed settling execution still fails even after an earlier failed attempt', () => {
  const { evidence, native } = retried();
  native.traces.find(row => row.turn_id === 'first')!.status = 'failed';
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow('Native execution failed');
});

test('a receipt whose execution is not among the delivery executions gets no retry excuse: every attempt is judged', () => {
  const { evidence, native } = retried();
  evidence.selectedDeliveries![0]!.receipt!.execution_id = 'not-listed';
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow('Native execution failed');
});

test('a non-settling revisit is judged by its trace only: completed without a usage row passes, usage coverage reports it', () => {
  const { evidence, native } = fixture();
  evidence.selectedDeliveries![0]!.executionIds.push('second');
  evidence.batches![1]!.deliveryIds.push('first');
  native.usage = native.usage.filter(row => row.wake !== 'second');
  // 'second' still settles its own delivery, so its usage row stays mandatory there.
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow('token usage');
  // Under 'first' alone, a completed non-settling attempt needs a trace, not a usage row.
  evidence.selectedDeliveries![1]!.executionIds = [];
  evidence.selectedDeliveries!.pop();
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).not.toThrow();
  native.traces.splice(native.traces.findIndex(row => row.turn_id === 'second'), 1);
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow('terminal telemetry');
});

test('a judged attempt sealed on its declared limit raises the labelled stop only once nothing else failed', () => {
  const { evidence, native } = fixture();
  native.traces[1]!.status = 'failed';
  native.usage[1] = { ...native.usage[1]!, limit_reason: 'timeout' };
  expect(() => validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer')).toThrow(DeclaredLimitStop);
  try { validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer'); } catch (error) {
    expect(error).toMatchObject({ limit: 'timeout', message: expect.stringContaining('Native execution failed') });
  }
  // One attempt that failed any other way is still a plain failure, whatever order it appears in.
  native.traces[0]!.status = 'failed';
  let caught: unknown;
  try { validateTransportExecutions(evidence, native, activityFixture(), 'agent:writer'); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(DeclaredLimitStop);
  // A limit attempt never excuses missing ownership evidence for the rest of the history.
  const orphaned = fixture();
  orphaned.native.traces[1]!.status = 'failed';
  orphaned.native.usage[1] = { ...orphaned.native.usage[1]!, limit_reason: 'requests' };
  orphaned.native.traces.unshift({ ...traceFixture(), turn_id: 'between-polls' });
  expect(() => validateTransportExecutions(orphaned.evidence, orphaned.native, activityFixture(), 'agent:writer'))
    .toThrow('terminal trace omitted execution ownership');
});
