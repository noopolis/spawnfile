import { expect, test, vi } from 'vitest';
import { activityFixture, receiptFixture } from '../../test-fixtures.js';
import type { NativeHost } from '../types.js';
import { createTransportDelivery } from './transport.js';
import type { NativeAcceptance, NativeWakeRequest } from './types.js';

const source = { kind: 'transport' as const, deliveryId: 'trial:wake' };
const request: NativeWakeRequest = { agent_id: 'agent:writer', delivery_id: 'trial:wake', event: {
  version: 'noopolis.daimon.wake.v2', kind: 'message', text: 'original', occurred_at: '2026-10-11T01:00:00.000Z' } };
const accepted = { ...receiptFixture(), state: 'accepted' as const };
const available = { version: 'availability', state: 'running', agents: [] };

test('acceptances begun before arming and conflicting public identities cannot bind', async () => {
  let resolve!: (value: NativeAcceptance) => void;
  const host = { accept: vi.fn(() => new Promise<NativeAcceptance>(done => { resolve = done; })) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const early = transport.accept(request);
  const run = transport.begin('task', source);
  resolve(accepted); await early;
  expect(transport.state().state).toBe('waiting');
  vi.mocked(host.accept).mockResolvedValue({ ...accepted, acceptance_id: 'other', agent_id: 'foreign' });
  await transport.accept(request); expect(transport.state().state).toBe('waiting');
  vi.mocked(host.accept).mockResolvedValue({ ...accepted, acceptance_id: 'new', delivery_id: 'foreign' });
  await transport.accept(request); expect(transport.state().state).toBe('waiting');
  run.finish(); expect(transport.state()).toEqual({ state: 'idle' });
});

test('rejections are forwarded and do not poison a later genuine acceptance', async () => {
  const host = { accept: vi.fn().mockResolvedValue({ state: 'rejected', code: 'delivery_conflict' }) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  expect(await transport.accept(request)).toEqual({ state: 'rejected', code: 'delivery_conflict' });
  const run = transport.begin('task', source);
  vi.mocked(host.accept).mockResolvedValue(accepted);
  await transport.accept(request); expect(await run.accepted).toEqual(accepted);
  run.observe(receiptFixture(), activityFixture(), available);
  expect(run.evidence.batch).toBeUndefined();
  expect(run.evidence.deliveries).toHaveLength(1);
  run.finish();
});

test('a thrown persistence error before arming permits a genuine later retry', async () => {
  const host = { accept: vi.fn().mockRejectedValueOnce(new Error('store unavailable')).mockResolvedValue(accepted) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  await expect(transport.accept(request)).rejects.toThrow('store unavailable');
  const run = transport.begin('task', source);
  await transport.accept(request);
  expect(transport.state().state).toBe('observing');
  expect(await run.accepted).toEqual(accepted);
  run.finish();
});

test.each([true, false])('overlapping retry keeps its own arrival when a pre-arm attempt throws (retry settles first: %s)', async retryFirst => {
  let reject!: (error: Error) => void;
  let resolve!: (value: NativeAcceptance) => void;
  const host = { accept: vi.fn().mockImplementationOnce(() => new Promise((_resolve, failed) => { reject = failed; }))
    .mockImplementationOnce(() => new Promise<NativeAcceptance>(done => { resolve = done; })) } as unknown as NativeHost;
  const transport = createTransportDelivery(host, 'agent:writer');
  const early = transport.accept(request).catch(() => undefined);
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
  current.finish();
});
