import { expect, test } from 'vitest';
import { activityFixture, receiptFixture, traceFixture } from '../../test-fixtures.js';
import type { NativeEvidence } from '../types.js';
import { validateTransportExecutions } from './terminal.js';
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

test('requires every selected execution, including a deferred revisit, to have a batch and completed telemetry', () => {
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
