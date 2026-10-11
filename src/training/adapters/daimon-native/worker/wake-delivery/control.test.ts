import { afterEach, expect, test, vi } from 'vitest';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configFixture, launchFixture, receiptFixture, traceFixture } from '../../test-fixtures.js';
import { createWorkerController } from '../control.js';
import * as evidence from '../evidence/index.js';
import { requestTransportDelivery, type NativeWorkerRequest } from '../../transport/index.js';
import type { NativeActivity, NativeHost, NativeReceipt, WorkerOptions } from '../types.js';
import type { NativeWakeRequest } from './types.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(timeoutMs = 1500) {
  const f = await launchFixture(); roots.push(f.root); f.launch.delivery = 'transport';
  const config = configFixture(f.root);
  const home = config.agents[0]!.runtimeHomePath;
  await mkdir(join(home, 'telemetry'), { recursive: true });
  await mkdir(join(home, '.codex/sessions'), { recursive: true });
  const receipts = new Map<string, NativeReceipt>();
  let executions: NativeActivity['executions'] = [];
  let activeReads = 0;
  const host: NativeHost = {
    start: async () => undefined, stop: vi.fn(async () => ({})), health: async () => ({ version: 'health', state: 'running', agents: [] }),
    accept: vi.fn(async (value: unknown) => {
      const request = value as NativeWakeRequest;
      let receipt = receipts.get(request.delivery_id);
      if (!receipt) {
        receipt = { ...receiptFixture(), acceptance_id: randomUUID(), agent_id: request.agent_id, delivery_id: request.delivery_id,
          execution_id: undefined, state: 'accepted', accepted_at: new Date().toISOString() };
        receipts.set(request.delivery_id, receipt);
      }
      return { ...receipt, state: 'accepted' as const };
    }),
    wakeReceipt: async (_token, id) => [...receipts.values()].find(row => row.acceptance_id === id),
    activityV2: async () => { if (executions?.length) activeReads++; return { version: 'activity',
      items: [...receipts.values()].map(row => ({ ...row, active: row.state === 'running' })), executions }; },
    availability: async () => ({ version: 'availability', state: 'running', agents: [
      { agent_id: 'agent:writer', pending: 0, running: true, deferred: 0, budget: { remaining: 3 } }] }),
  };
  const options: WorkerOptions = { launch: f.launch.receiptFile, config: f.launch.config, configSha256: f.launch.configSha256,
    controlRoot: f.launch.controlRoot, tokenFile: f.launch.tokenFile, evidence: join(f.launch.controlRoot, 'evidence.json'),
    trialId: 'trial', timeoutMs, scheduleOverride: 'disabled' };
  const clock = { version: 'noopolis.task-clock.v1' as const, origin: '2024-02-29T00:00:00Z', anchorEpochMs: Date.now() };
  const controller = createWorkerController(host, config, options, 'isolated-token', f.launch, clock);
  const deliver = (delivery_id: string, agent_id = 'agent:writer') => controller.transport!.accept({ token: 'isolated-token', agent_id, delivery_id,
    event: { version: 'noopolis.daimon.wake.v2', kind: 'message', text: '[room tasks] editor\nDo the work', occurred_at: '2026-10-11T01:02:03.456Z' } });
  const dispatch = async (ids: string[], executionId: string) => {
    for (const id of ids) Object.assign(receipts.get(id)!, { state: 'running', execution_id: executionId, deferred: false });
    const before = activeReads;
    executions = [{ agent_id: 'agent:writer', execution_id: executionId, state: 'running', delivery_ids: ids }];
    await vi.waitFor(() => expect(activeReads).toBeGreaterThan(before), { timeout: 1000, interval: 10 });
  };
  const close = async (ids: string[], executionId: string, deferred: string[] = [], status: 'completed' | 'failed' = 'completed') => {
    await appendFile(join(f.launch.controlRoot, 'usage.jsonl'), JSON.stringify({ v: 'noopolis.daimon.turn-usage.v1', agent: 'agent:writer',
      wake: executionId, engine: 'codex', at: '2026-10-11T01:03:00.000Z', input: 1, output: 1, cache_read: 0, total: 2, complete: true }) + '\n');
    await writeFile(join(home, '.codex/sessions/unit.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: 'test-model-v1' } }) + '\n');
    await appendFile(join(home, 'telemetry/turns.ndjson'), JSON.stringify({ ...traceFixture(), turn_id: executionId, status }) + '\n');
    for (const id of ids) Object.assign(receipts.get(id)!, { state: deferred.includes(id) ? 'accepted' : 'completed',
      deferred: deferred.includes(id), execution_id: deferred.includes(id) ? undefined : executionId });
    executions = [];
  };
  return { f, host, controller, deliver, dispatch, close, options, clock };
}

test('transport run never accepts itself; binds a native batch of two and persists original envelope and clock', async () => {
  const f = await fixture();
  const result = f.controller.run('task', '', {}, { kind: 'transport', deliveryIdPrefix: 'moltnet:' });
  expect(f.controller.transport!.state()).toEqual({ state: 'waiting', wakeId: 'task', source: { kind: 'transport', deliveryIdPrefix: 'moltnet:' } });
  expect(f.host.accept).not.toHaveBeenCalled();
  await f.deliver('moltnet:foreign', 'different-agent');
  await f.deliver('other:1');
  expect(f.controller.transport!.state().state).toBe('waiting');
  await f.deliver('moltnet:1'); await f.deliver('moltnet:2');
  const execution = randomUUID(); await f.dispatch(['moltnet:1', 'moltnet:2'], execution);
  await f.close(['moltnet:1', 'moltnet:2'], execution);
  const terminal = await result;
  expect(terminal.status, terminal.error).toBe('completed');
  expect(terminal.receipt?.delivery_id).toBe('moltnet:1');
  expect(terminal.transport?.batch?.deliveryIds).toEqual(['moltnet:1', 'moltnet:2']);
  expect(terminal.transport?.deliveries.map(row => row.deliveryId)).toEqual(['moltnet:1', 'moltnet:2']);
  expect(terminal.transport?.deliveries[0]?.event).toEqual({ version: 'noopolis.daimon.wake.v2', kind: 'message',
    text: '[room tasks] editor\nDo the work', occurred_at: '2026-10-11T01:02:03.456Z' });
  expect(terminal.transport?.allowances).toMatchObject({ source: 'availability', budget: { remaining: 3 } });
  expect(terminal.transport?.renderedAllowances).toBe('unavailable-public-api');
  expect(terminal.taskClock).toEqual(f.clock);
  expect(f.host.accept).toHaveBeenCalledTimes(4);
  expect(f.controller.transport!.state()).toEqual({ state: 'idle' });
  const persisted = JSON.parse(await readFile(join(f.options.controlRoot, 'evidence.1.json'), 'utf8'));
  expect(persisted).toEqual(JSON.parse(JSON.stringify(terminal)));
  expect(persisted.native.modelContexts).toHaveLength(1);
  expect(JSON.stringify(terminal)).not.toContain('isolated-token');
  await f.controller.stop();
});

test('no matching delivery by the deadline is a transport failure, never a fresh manual wake', async () => {
  const f = await fixture(50);
  const pending = f.controller.run('task', '', {}, { kind: 'transport', deliveryId: 'moltnet:expected' });
  await f.deliver('unrelated');
  const result = await pending;
  expect(result.status).toBe('failed');
  expect(result.error).toBe('Transport delivery deadline exceeded: no matching delivery arrived');
  expect(result.transport?.deliveryId).toBeUndefined();
  expect(result.receipt).toBeUndefined();
  expect(f.host.accept).toHaveBeenCalledTimes(1);
  expect(f.host.stop).toHaveBeenCalledTimes(1);
});

test('an old acceptance retry cannot bind a run that started later', async () => {
  const f = await fixture(50);
  await f.deliver('moltnet:old');
  const pending = f.controller.run('task', '', {}, { kind: 'transport', deliveryIdPrefix: 'moltnet:' });
  await f.deliver('moltnet:old');
  expect((await pending).error).toMatch(/no matching delivery/);
});

test('deferred batch members never pass; continuation waits for its declared message only and preserves both frames', async () => {
  const f = await fixture();
  const first = f.controller.run('task', '', { maxExternalDeliveries: 1 }, { kind: 'transport', deliveryId: 'm:task' });
  await f.deliver('m:task'); await f.deliver('m:peer');
  const e1 = randomUUID(); await f.dispatch(['m:task', 'm:peer'], e1);
  await f.close(['m:task', 'm:peer'], e1, ['m:peer']);
  const blocked = await first;
  expect(blocked.status).toBe('failed');
  expect(blocked.blocked).toBe('awaiting-external-input');
  expect(blocked.transport?.deferredDeliveryIds).toEqual(['m:peer']);
  expect(f.host.stop).not.toHaveBeenCalled();
  const second = f.controller.run('answer', '', {}, { kind: 'transport', deliveryId: 'm:answer' });
  await f.deliver('m:unexpected'); expect(f.controller.transport!.state().state).toBe('waiting');
  await f.deliver('m:answer');
  const e2 = randomUUID(); await f.dispatch(['m:peer', 'm:answer'], e2); await f.close(['m:peer', 'm:answer'], e2);
  const completed = await second;
  expect(completed.status).toBe('completed');
  expect(completed.transport?.selectedDeliveries?.find(row => row.deliveryId === 'm:peer')?.executionIds).toEqual([e1, e2]);
  expect(completed.transport?.batches?.map(row => row.executionId)).toEqual([e1, e2]);
  expect(blocked.transport?.batches?.map(row => row.executionId)).toEqual([e1]);
  expect(JSON.parse(await readFile(join(f.options.controlRoot, 'evidence.1.json'), 'utf8')).wakeId).toBe('task');
  expect(JSON.parse(await readFile(join(f.options.controlRoot, 'evidence.2.json'), 'utf8')).receipt.delivery_id).toBe('m:answer');
  await f.controller.stop();
});

test('a later completed answer cannot erase a previously deferred trial delivery', async () => {
  const f = await fixture();
  const first = f.controller.run('task', '', { maxExternalDeliveries: 1 }, { kind: 'transport', deliveryId: 'm:task' });
  await f.deliver('m:task');
  const e1 = randomUUID(); await f.dispatch(['m:task'], e1); await f.close(['m:task'], e1, ['m:task']);
  expect((await first).blocked).toBe('awaiting-external-input');
  const next = f.controller.run('answer', '', {}, { kind: 'transport', deliveryId: 'm:answer' });
  await f.deliver('m:answer');
  const e2 = randomUUID(); await f.dispatch(['m:answer'], e2); await f.close(['m:answer'], e2);
  const result = await next;
  expect(result.status).toBe('failed'); expect(result.blocked).toBe('awaiting-external-input');
  expect(result.transport?.unresolvedDeliveryIds).toEqual(['m:task']);
  expect(f.host.stop).toHaveBeenCalledTimes(1);
});

test('missing live batch observation fails closed even with a completed receipt and trace', async () => {
  const f = await fixture();
  const pending = f.controller.run('task', '', {}, { kind: 'transport', deliveryId: 'm:task' });
  const execution = randomUUID();
  await f.deliver('m:task'); await f.close(['m:task'], execution);
  expect((await pending).error).toMatch(/without observable batch/);
});

test.each(['completed', 'failed'] as const)('retains and validates a second selected execution with a %s trace', async status => {
  const f = await fixture();
  const pending = f.controller.run('task', '', {}, { kind: 'transport', deliveryIdPrefix: 'm:' });
  await f.deliver('m:1'); await f.deliver('m:2');
  const first = randomUUID(); const second = randomUUID();
  await f.dispatch(['m:1'], first); await f.close(['m:1'], first);
  await f.dispatch(['m:2'], second); await f.close(['m:2'], second, [], status);
  const result = await pending;
  expect(result.status, result.error).toBe(status);
  if (status === 'failed') {
    expect(result.error).toContain('Native execution failed');
    expect(result.blocked).toBeUndefined();
  }
  expect(result.transport?.deliveries.map(row => row.deliveryId)).toEqual(['m:1', 'm:2']);
  expect(result.transport?.selectedDeliveries).toMatchObject([
    { deliveryId: 'm:1', executionIds: [first], receipt: { state: 'completed' } },
    { deliveryId: 'm:2', executionIds: [second], receipt: { state: 'completed' } },
  ]);
  expect(result.transport?.batches?.map(row => [row.executionId, row.deliveryIds])).toEqual([[first, ['m:1']], [second, ['m:2']]]);
  expect(result.transport?.batches?.every(row => row.allowances?.source === 'availability')).toBe(true);
  expect(result.native.traces.map(row => row.turn_id)).toEqual([first, second]);
  expect(result.native.usage.map(row => row.wake)).toEqual([first, second]);
  await f.controller.stop();
});

test.each([false, true])('rechecks late admission during terminal collection (acceptance still in flight: %s)', async inFlight => {
  const f = await fixture();
  let collected!: () => void; let releaseCollection!: () => void;
  const collecting = new Promise<void>(resolve => { collected = resolve; });
  const held = new Promise<void>(resolve => { releaseCollection = resolve; });
  const collect = evidence.collectNativeEvidence;
  const spy = vi.spyOn(evidence, 'collectNativeEvidence').mockImplementationOnce(async (...args) => {
    const snapshot = await collect(...args);
    collected(); await held;
    return snapshot;
  });
  let settled = false;
  const pending = f.controller.run('task', '', {}, { kind: 'transport', deliveryIdPrefix: 'm:' }).finally(() => { settled = true; });
  await f.deliver('m:1');
  const first = randomUUID(); const second = randomUUID();
  await f.dispatch(['m:1'], first); await f.close(['m:1'], first);
  await collecting;
  let releaseAcceptance!: () => void;
  if (inFlight) {
    const accept = f.host.accept;
    vi.mocked(f.host.accept).mockImplementationOnce(async value => {
      await new Promise<void>(resolve => { releaseAcceptance = resolve; });
      return accept(value);
    });
  }
  const arrival = f.deliver('m:2');
  if (inFlight) {
    releaseCollection();
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2), { interval: 1 });
    expect(settled).toBe(false);
    releaseAcceptance();
  }
  await arrival;
  const dispatched = f.dispatch(['m:2'], second);
  releaseCollection();
  await dispatched;
  await f.close(['m:2'], second);
  const result = await pending;
  expect(result.status, result.error).toBe('completed');
  expect(result.transport?.unresolvedDeliveryIds).toEqual([]);
  expect(result.transport?.selectedDeliveries?.map(row => row.deliveryId)).toEqual(['m:1', 'm:2']);
  expect(result.native.traces.map(row => row.turn_id)).toEqual([first, second]);
  expect(spy.mock.calls.length).toBeGreaterThan(1);
  await f.controller.stop();
});

test('a publisher cannot admit another delivery after terminal sealing and return the earlier success', async () => {
  const f = await fixture();
  const source = { kind: 'transport' as const, deliveryIdPrefix: 'm:' };
  let terminal: ReturnType<typeof f.controller.run>;
  const request = (async (_path: string, body?: unknown) => {
    if (body) return await (terminal = f.controller.run('task', '', {}, source));
    return f.controller.transport!.state();
  }) as NativeWorkerRequest;
  const publish = async () => {
    await f.deliver('m:1');
    const execution = randomUUID();
    await f.dispatch(['m:1'], execution); await f.close(['m:1'], execution);
    expect((await terminal).status).toBe('completed');
    await f.deliver('m:2');
  };
  await expect(requestTransportDelivery(request, { wakeId: 'task', source }, { source, publish }, Date.now() + 1500,
    new AbortController().signal)).rejects.toThrow('transport_admission_sealed');
  expect(f.host.accept).toHaveBeenCalledTimes(1);
  await f.controller.stop();
});
