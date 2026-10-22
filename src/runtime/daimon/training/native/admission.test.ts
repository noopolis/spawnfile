import { expect, it } from 'vitest';
import { nativeAdmission } from './admission.js';
import { unadmittedFixture } from './test-fixtures.js';

it('projects explicit zero admission without fabricating usage', () => {
  expect(nativeAdmission(unadmittedFixture())).toEqual({ executionRecords: 0, executionsUsed: 0,
    agentExecutionsUsed: 0, tokensUsed: 0, agentTokensUsed: 0, toolEvents: 0, outputEvents: 0 });
});

it('fails closed with a valid first availability agent followed by another agent', () => {
  const frame = unadmittedFixture();
  const agent = frame.availability!.agents[0]!;
  frame.availability!.agents.push({ ...agent, agent_id: 'agent:other' });
  expect(Object.values(nativeAdmission(frame)).every(count => count === 0)).toBe(false);
});

const mutations: [string, unknown][] = [
  ['receipt', undefined], ['receipt.version', 'foreign'], ['receipt.agent_id', 'foreign'], ['receipt.state', 'completed'],
  ['receipt.deferred', true], ['receipt.execution_id', 'execution'], ['receipt.delivery_id', 'foreign'],
  ['receipt.acceptance_id', undefined],
  ['activity', undefined], ['activity.version', 'foreign'], ['activity.items', undefined], ['activity.items', []],
  ['activity.items', [null]], ['activity.items.0.agent_id', 'foreign'], ['activity.items.0.delivery_id', 'foreign'],
  ['activity.items.0.acceptance_id', 'foreign'], ['activity.items.0.acceptance_id', undefined], ['activity.items.0.execution_id', 'execution'],
  ['activity.items.0.state', 'running'], ['activity.items.0.active', true], ['activity.items.0.deferred', true],
  ['activity.executions', undefined], ['activity.executions', [{}]], ['native.traces', [{}]], ['native.usage', [{}]],
  ['native.modelContexts', [{}]], ['native.accounting', undefined], ['native.accounting.usage', [{}]],
  ['native.toolReceipts', undefined], ['native.toolReceipts', [{}]], ['native.requests', [{}]], ['native.turnSeals', [{}]],
  ['availability', undefined], ['availability.version', 'foreign'], ['availability.agents', undefined],
  ['availability.agents', []], ['availability.agents', [null]], ['availability.agents.0.agent_id', 'foreign'],
  ['availability.agents.0.running', true], ['availability.agents.0.budget', null],
  ['availability.agents.0.budget.armed', false], ['availability.agents.0.budget.epoch', 'foreign'],
  ...['executions_used', 'agent_executions_used', 'tokens_used', 'agent_tokens_used'].flatMap(key =>
    [undefined, 1, -1, '0', NaN].map(value => [`availability.agents.0.budget.${key}`, value] as [string, unknown])),
  ['executionId', 'execution'], ['receipt.text', 'subject output'], ['receipt.text', null],
  ['activity.items.0.text', 'subject output'], ['coverage', []], ['coverage', undefined],
];
it.each(mutations)('never proves zero admission with %s = %s', (path, value) => {
  const frame = unadmittedFixture();
  const keys = path.split('.');
  let parent = frame as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  expect(Object.values(nativeAdmission(frame)).every(count => count === 0)).toBe(false);
});

function transportFrame() {
  const frame = unadmittedFixture();
  const receipt = frame.receipt!;
  frame.transport = { source: { kind: 'transport', deliveryId: receipt.delivery_id }, deliveryId: receipt.delivery_id,
    acceptanceId: receipt.acceptance_id, deliveries: [], deferredDeliveryIds: [], unresolvedDeliveryIds: [receipt.delivery_id],
    renderedAllowances: 'unavailable-public-api', selectedDeliveries: [{ deliveryId: receipt.delivery_id,
      executionIds: [], receipt: { ...receipt } }], batches: [] };
  return frame;
}
it.each([false, true].flatMap(transport => [undefined, '', '   ', null, 0].map(identity => ({ transport, identity }))))(
  'fails closed when every acceptance identity is $identity (transport: $transport)', ({ transport, identity }) => {
    const frame = transport ? transportFrame() : unadmittedFixture();
    const receipts = [frame.receipt!, ...frame.activity!.items, ...(frame.transport?.selectedDeliveries ?? []).map(row => row.receipt!)];
    for (const receipt of receipts) {
      if (identity === undefined) delete (receipt as Partial<typeof receipt>).acceptance_id;
      else (receipt as unknown as Record<string, unknown>).acceptance_id = identity;
    }
    if (frame.transport) {
      if (identity === undefined) delete frame.transport.acceptanceId;
      else (frame.transport as unknown as Record<string, unknown>).acceptanceId = identity;
    }
    expect(Object.values(nativeAdmission(frame)).every(count => count === 0)).toBe(false);
});
it('proves a bound transport acceptance without an execution, allowing absent receipt text', () => {
  const frame = transportFrame(); delete frame.receipt!.text;
  frame.native.requests = []; frame.native.turnSeals = [];
  expect(Object.values(nativeAdmission(frame)).every(count => count === 0)).toBe(true);
});
it.each([
  ['acceptanceId', 'foreign'], ['acceptanceId', undefined], ['selectedDeliveries', undefined], ['selectedDeliveries', []], ['selectedDeliveries', [null]],
  ['selectedDeliveries.0.deliveryId', 'foreign'], ['selectedDeliveries.0.executionIds', undefined],
  ['selectedDeliveries.0.executionIds', ['execution']], ['selectedDeliveries.0.receipt', undefined],
  ['selectedDeliveries.0.receipt.execution_id', 'execution'], ['selectedDeliveries.0.receipt.agent_id', 'foreign'],
  ['selectedDeliveries.0.receipt.delivery_id', 'foreign'], ['selectedDeliveries.0.receipt.acceptance_id', 'foreign'],
  ['selectedDeliveries.0.receipt.acceptance_id', undefined],
  ['selectedDeliveries.0.receipt.state', 'completed'], ['selectedDeliveries.0.receipt.deferred', true],
  ['selectedDeliveries.0.receipt.text', 'subject output'],
  ['batches', undefined], ['batches', [{}]], ['batch', {}],
] as [string, unknown][])('fails closed on transport %s = %s', (path, value) => {
  const frame = transportFrame(); const keys = path.split('.');
  let parent = frame.transport as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  expect(Object.values(nativeAdmission(frame)).every(count => count === 0)).toBe(false);
});
