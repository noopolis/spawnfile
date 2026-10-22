import { expect, test, vi } from 'vitest';
import { activityFixture, receiptFixture, traceFixture } from '../../test-fixtures.js';
import type { NativeHost } from '../types.js';
import { createTransportDelivery } from './transport.js';
import type { NativeAcceptance, NativeWakeRequest } from './types.js';

const source = { kind: 'transport' as const, deliveryId: 'trial:wake' };
const request: NativeWakeRequest = { agent_id: 'agent:writer', delivery_id: 'trial:wake', event: {
  version: 'noopolis.daimon.wake.v2', kind: 'message', text: 'original', occurred_at: '2026-10-11T01:00:00.000Z' } };
const accepted = { ...receiptFixture(), state: 'accepted' as const };
const available = { version: 'availability', state: 'running', agents: [
  { agent_id: 'agent:writer', pending: 0, running: false, deferred: 0, budget: undefined }] };

test('every identity is refused before the first arm without calling the native host', async () => {
  const host = { accept: vi.fn() } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  for (const value of [request, { ...request, agent_id: 'foreign' }, {}, null]) {
    await expect(transport.accept(value)).rejects.toThrow('transport_admission_sealed');
  }
  expect(host.accept).not.toHaveBeenCalled();
  expect(transport.state()).toEqual({ state: 'idle' });
});

test.each(['agent_id', 'delivery_id'] as const)('a conflicting returned %s cannot bind a fresh delivery', async field => {
  // Each conflict reaches an undecided queue, so deleting its identity check
  // really does bind the forged acceptance and makes this test fail.
  const host = { accept: vi.fn().mockResolvedValue({ ...accepted, [field]: 'foreign' }) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const run = transport.begin('task', source);
  await transport.accept(request);
  expect(host.accept).toHaveBeenCalledOnce();
  expect(transport.state().state).toBe('waiting');
  expect(run.evidence.deliveryId).toBeUndefined();
  expect(run.evidence.deliveries).toEqual([]);
  run.finish();
});

test('terminal sealing settles admission and requires an unchanged generation', async () => {
  let resolve!: (value: NativeAcceptance) => void;
  const transport = createTransportDelivery({ accept: () => new Promise<NativeAcceptance>(done => { resolve = done; }) } as unknown as NativeHost, 'agent:writer');
  const run = transport.begin('task', source);
  const before = run.generation();
  const pending = transport.accept(request);
  expect(run.seal(run.generation(), [])).toBe(false); // Same generation, but still in flight.
  resolve(accepted); await pending;
  expect(run.seal(before, [])).toBe(false); // Settled, but evidence predates admission.
  expect(run.evidence.unresolvedDeliveryIds).toEqual([request.delivery_id]);
  expect(run.closed([])).toBe(false);
  expect(run.seal(run.generation(), [])).toBe(false); // No terminal observations yet.
  run.observe(receiptFixture(), activityFixture(), available);
  expect(run.seal(run.generation(), [traceFixture()])).toBe(true);
  expect(transport.state()).toEqual({ state: 'idle' });
});

test.each([
  { pending: 1, deferred: 1, closes: true },
  { pending: 2, deferred: 1, closes: false }, // Extra pending work, even if absent from activity.
  { pending: 0, deferred: 1, closes: false },
  { pending: 1, deferred: 0, closes: false },
  { pending: 1, deferred: 2, closes: false },
  { pending: 2, deferred: 2, closes: false }, // Equal counts cannot stand in for selected receipts.
  { pending: 0, deferred: 0, closes: false },
])('selected deferred receipt reconciles pending=$pending deferred=$deferred (closes: $closes)', async ({ pending, deferred, closes }) => {
  const transport = createTransportDelivery({ accept: async () => accepted } as unknown as NativeHost, 'agent:writer');
  const run = transport.begin('task', source);
  await transport.accept(request);
  // Observe the live execution before Daimon clears its binding on deferral.
  run.observe({ ...receiptFixture(), state: 'running' }, activityFixture(true), available);
  const receipt = { ...receiptFixture(), state: 'accepted' as const, deferred: true, execution_id: undefined };
  const activity = { ...activityFixture(), items: [{ ...receipt, active: false }] };
  run.observe(receipt, activity, { ...available, agents: [{ ...available.agents[0]!, pending, deferred }] });
  // This delivery appears in both control reads but counts only once.
  expect(run.evidence.selectedDeliveries).toHaveLength(1);
  expect(run.closed([])).toBe(false); // A deferral never substitutes for a closed trace.
  expect(run.closed([traceFixture()])).toBe(closes);
  expect(run.seal(run.generation(), [traceFixture()])).toBe(closes);
  run.finish();
});

test('two selected deferred identities close, but an unrelated or undisposed receipt keeps closure open', async () => {
  const transport = createTransportDelivery({ accept: async (value: unknown) => {
    const request = value as NativeWakeRequest;
    return { ...accepted, delivery_id: request.delivery_id, acceptance_id: request.delivery_id };
  } } as unknown as NativeHost, 'agent:writer');
  const run = transport.begin('task', { kind: 'transport', deliveryIdPrefix: 'trial:' });
  const receipts = ['trial:wake', 'trial:peer'].map(delivery_id => ({ ...receiptFixture(), delivery_id,
    acceptance_id: delivery_id, state: 'accepted' as const, deferred: true, execution_id: undefined }));
  for (const row of receipts) await transport.accept({ ...request, delivery_id: row.delivery_id });
  const primary = receipts[0]!;
  const active = { ...activityFixture(true), items: receipts.map(row => ({ ...row, active: true, state: 'running' as const, deferred: false })),
    executions: [{ ...activityFixture(true).executions![0]!, delivery_ids: receipts.map(row => row.delivery_id) }] };
  run.observe(primary, active, available);
  const activity = { ...activityFixture(), items: receipts.map(row => ({ ...row, active: false })) };
  const availability = { ...available, agents: [{ ...available.agents[0]!, pending: 2, deferred: 2 }] };
  run.observe(primary, activity, availability);
  expect(run.evidence.selectedDeliveries).toHaveLength(2);
  expect(run.closed([traceFixture()])).toBe(true);
  for (const deferred of [true, false]) {
    const extra = { ...primary, delivery_id: 'unrelated', acceptance_id: 'unrelated', deferred, active: false };
    run.observe(primary, { ...activity, items: [...activity.items, extra] }, availability);
    expect(run.closed([traceFixture()])).toBe(false);
  }
  // Even a selected receipt cannot borrow its peer's deferred disposition.
  run.observe(primary, { ...activity, items: [{ ...receipts[1]!, deferred: false, active: false }] }, availability);
  expect(run.closed([traceFixture()])).toBe(false);
  run.finish();
});

test('rejections are forwarded and do not poison a later genuine acceptance', async () => {
  const host = { accept: vi.fn().mockResolvedValue({ state: 'rejected', code: 'delivery_conflict' }) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const run = transport.begin('task', source);
  expect(await transport.accept(request)).toEqual({ state: 'rejected', code: 'delivery_conflict' });
  vi.mocked(host.accept).mockResolvedValue(accepted);
  await transport.accept(request); expect(await run.accepted).toEqual(accepted);
  run.observe(receiptFixture(), activityFixture(), available);
  expect(run.evidence.batch).toBeUndefined();
  expect(run.evidence.deliveries).toHaveLength(1);
  run.finish();
});

test('selected receipt identity cannot change after native acceptance', async () => {
  const transport = createTransportDelivery({ accept: async () => accepted } as unknown as NativeHost, 'agent:writer');
  const run = transport.begin('task', source);
  await transport.accept(request);
  expect(() => run.observe({ ...receiptFixture(), acceptance_id: 'foreign' }, activityFixture(), available)).toThrow('acceptance identity');
  run.finish();
});

test('sealed runs refuse new admission, retain authentic retries, and reopen only on the next arm', async () => {
  const host = { accept: vi.fn().mockResolvedValue(accepted) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const run = transport.begin('task', source);
  await transport.accept(request);
  run.observe(receiptFixture(), activityFixture(), available);
  expect(run.seal(run.generation(), [traceFixture()])).toBe(true);
  const next = { ...request, delivery_id: 'next' };
  await expect(transport.accept(next)).rejects.toThrow('transport_admission_sealed');
  expect(host.accept).toHaveBeenCalledTimes(1);
  expect(await transport.accept(request)).toEqual(accepted);
  expect(host.accept).toHaveBeenCalledTimes(2);
  const current = transport.begin('next', { kind: 'transport', deliveryId: 'next' });
  vi.mocked(host.accept).mockResolvedValue({ ...accepted, acceptance_id: 'new', delivery_id: 'next' });
  await transport.accept(next);
  expect(await current.accepted).toMatchObject({ delivery_id: 'next' });
  current.finish();
});

test.each(['agent_id', 'delivery_id'] as const)('a mismatched native %s never earns an idempotent retry after sealing', async field => {
  const host = { accept: vi.fn().mockResolvedValue({ ...accepted, [field]: 'foreign' }) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const run = transport.begin('task', source);
  await transport.accept(request); run.finish();
  await expect(transport.accept(request)).rejects.toThrow('transport_admission_sealed');
  expect(host.accept).toHaveBeenCalledOnce();
});

test('a thrown persistence error permits a genuine later retry', async () => {
  const host = { accept: vi.fn().mockRejectedValueOnce(new Error('store unavailable')).mockResolvedValue(accepted) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const run = transport.begin('task', source);
  await expect(transport.accept(request)).rejects.toThrow('store unavailable');
  await transport.accept(request);
  expect(transport.state().state).toBe('observing');
  expect(await run.accepted).toEqual(accepted);
  run.finish();
});

test.each([true, false])('overlapping retry keeps its own arrival when an older run attempt throws (retry settles first: %s)', async retryFirst => {
  let reject!: (error: Error) => void;
  let resolve!: (value: NativeAcceptance) => void;
  const host = { accept: vi.fn().mockImplementationOnce(() => new Promise((_resolve, failed) => { reject = failed; }))
    .mockImplementationOnce(() => new Promise<NativeAcceptance>(done => { resolve = done; })) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const old = transport.begin('old', source);
  const early = transport.accept(request).catch(() => undefined);
  old.finish();
  const run = transport.begin('task', source);
  const retry = transport.accept(request);
  if (retryFirst) { resolve(accepted); await retry; expect(transport.state().state).toBe('waiting'); }
  reject(new Error('store unavailable')); await early;
  if (!retryFirst) { resolve(accepted); await retry; }
  expect(transport.state().state).toBe('observing');
  expect(await run.accepted).toEqual(accepted);
  run.finish();
});

test('missing observations stay absent, and changed batch/execution authority refuses', async () => {
  const host = { accept: vi.fn().mockResolvedValue(accepted) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const run = transport.begin('task', source);
  run.observe(receiptFixture(), { ...activityFixture(), executions: undefined }, available);
  expect(run.evidence.deliveries).toEqual([]);
  await transport.accept(request); await run.accepted;
  const active = activityFixture(true);
  expect(() => run.observe(receiptFixture(), active, available, 'different')).toThrow(/binding changed/);
  run.observe(receiptFixture(), active, available);
  expect(run.evidence.allowances).toBeUndefined();
  expect(run.evidence.batch?.deliveryIds).toEqual(['trial:wake']);
  const changed = { ...active, executions: [{ ...active.executions![0]!, delivery_ids: ['trial:wake', 'another'] }] };
  expect(() => run.observe(receiptFixture(), changed, available)).toThrow(/membership changed/);
  // An observed peer envelope may be unavailable; membership still comes from
  // the runtime rather than inventing a payload for that peer.
  const next = transport.begin('next', source);
  next.observe(receiptFixture(), active, available);
  run.finish(); expect(transport.state()).toMatchObject({ wakeId: 'next' });
  next.finish();
});

test('an in-flight acceptance cannot move from an older armed run to its successor', async () => {
  let resolve!: (value: NativeAcceptance) => void;
  const transport = createTransportDelivery({ accept: () => new Promise<NativeAcceptance>(done => { resolve = done; }) } as unknown as NativeHost, 'agent:writer');
  const old = transport.begin('old', source);
  const arrival = transport.accept(request);
  old.finish(); const current = transport.begin('new', source);
  resolve(accepted); await arrival;
  expect(transport.state()).toMatchObject({ state: 'waiting', wakeId: 'new' });
  expect(old.seal(old.generation(), [])).toBe(false);
  current.finish();
});
