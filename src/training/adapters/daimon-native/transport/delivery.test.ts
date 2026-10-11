import { expect, it, vi } from 'vitest';
import { boundedTransportCall, requestTransportDelivery, transportTerminalBinding, verifyPreparedTransport } from './delivery.js';
import type { NativeWorkerRequest } from './types.js';
import type { TerminalEvidence, TransportDeliverySource } from '../worker/index.js';

const source = { kind: 'transport', deliveryId: 'moltnet:message-1' } as const;
const prefix = { kind: 'transport', deliveryIdPrefix: 'moltnet:' } as const;
const signal = () => new AbortController().signal;
const prepared = () => ({ source, publish: vi.fn(async () => undefined) });

it('validates reserved sources and refuses broad continuation selectors', () => {
  expect(() => verifyPreparedTransport(prepared(), true)).not.toThrow();
  expect(() => verifyPreparedTransport({ ...prepared(), source: prefix })).not.toThrow();
  expect(() => verifyPreparedTransport({ ...prepared(), source: prefix }, true)).toThrow('exact delivery ID');
  for (const bad of [null, { source }, { ...prepared(), extra: true }, { source, publish: 3 }]) {
    expect(() => verifyPreparedTransport(bad as ReturnType<typeof prepared>)).toThrow('Invalid prepared');
  }
  expect(() => verifyPreparedTransport({ ...prepared(), source: { kind: 'transport', deliveryId: '' } })).toThrow('source');
});

it('bounds prepare and publish callbacks by real time and propagates cancellation', async () => {
  const bound = Date.now() + 1000;
  let observed: AbortSignal | undefined;
  expect(await boundedTransportCall(async current => { observed = current; return 4; }, bound, signal())).toBe(4);
  expect(observed?.aborted).toBe(true);
  await expect(boundedTransportCall(async () => 4, bound, AbortSignal.abort())).rejects.toThrow('cancelled');
  await expect(boundedTransportCall(async () => 4, Date.now() - 1, signal())).rejects.toThrow('deadline');
  const hanging = async (current: AbortSignal): Promise<never> => { observed = current; return new Promise(() => undefined); };
  await expect(boundedTransportCall(hanging, Date.now() + 20, signal())).rejects.toThrow('deadline');
  expect(observed?.aborted).toBe(true);
  const cancelled = new AbortController();
  const pending = boundedTransportCall(hanging, bound, cancelled.signal);
  cancelled.abort();
  await expect(pending).rejects.toThrow('cancelled');
  const simultaneous = new AbortController();
  await expect(boundedTransportCall(async () => { simultaneous.abort(); return 1; }, bound, simultaneous.signal)).rejects.toThrow('cancelled');
});

function frame(expected: TransportDeliverySource = source): TerminalEvidence {
  return { agentId: 'agent:test', status: 'completed', completedAt: new Date().toISOString(), receipt: { agent_id: 'agent:test', delivery_id: source.deliveryId, acceptance_id: 'accepted-1' }, executionId: 'execution-1',
    transport: { source: expected, deliveryId: source.deliveryId, acceptanceId: 'accepted-1',
      batch: { executionId: 'execution-1', deliveryIds: [source.deliveryId, 'moltnet:message-2'] } } } as TerminalEvidence;
}

it('binds a batch to its real delivery, acceptance and requested selector', () => {
  expect(transportTerminalBinding(frame(), source)).toBe('bound');
  expect(transportTerminalBinding(frame(prefix), prefix)).toBe('bound');
  expect(transportTerminalBinding({ ...frame(), executionId: undefined }, source)).toBe('conflict');
  expect(transportTerminalBinding(frame(), undefined)).toBe('conflict');
  const mutations = [
    (value: TerminalEvidence) => { value.transport = undefined; },
    (value: TerminalEvidence) => { value.transport!.deliveryId = undefined; },
    (value: TerminalEvidence) => { value.receipt = undefined; },
    (value: TerminalEvidence) => { value.transport!.source = prefix; },
    (value: TerminalEvidence) => { value.transport!.deliveryId = 'moltnet:foreign'; },
    (value: TerminalEvidence) => { value.receipt!.delivery_id = 'trial:task'; },
    (value: TerminalEvidence) => { value.receipt!.acceptance_id = 'foreign'; },
    (value: TerminalEvidence) => { value.receipt!.agent_id = 'foreign'; },
    (value: TerminalEvidence) => { value.receipt!.execution_id = 'foreign'; },
    (value: TerminalEvidence) => { value.transport!.batch = undefined; },
    (value: TerminalEvidence) => { value.transport!.batch!.executionId = 'foreign'; },
    (value: TerminalEvidence) => { value.transport!.batch!.deliveryIds = ['foreign']; },
  ];
  for (const mutate of mutations) { const value = frame(); mutate(value); expect(transportTerminalBinding(value, source)).toBe('conflict'); }
  expect(transportTerminalBinding(frame({ kind: 'transport', deliveryIdPrefix: 'foreign:' }), prefix)).toBe('conflict');
  expect(transportTerminalBinding(frame(prefix), source)).toBe('conflict');
});

it('separates explicit failed incomplete observations from foreign evidence', () => {
  const absent = { ...frame(), status: 'failed', receipt: undefined, executionId: undefined,
    transport: { source } } as TerminalEvidence;
  expect(transportTerminalBinding(absent, source)).toBe('incomplete');
  expect(transportTerminalBinding({ ...absent, status: 'completed' }, source)).toBe('conflict');
  expect(transportTerminalBinding({ ...absent, blocked: 'awaiting-external-input' }, source)).toBe('conflict');
  expect(transportTerminalBinding(absent, replySource())).toBe('conflict');
  const missed = frame(); missed.status = 'failed'; missed.transport!.batch = undefined;
  expect(transportTerminalBinding(missed, source)).toBe('incomplete');
  missed.receipt!.delivery_id = 'foreign';
  expect(transportTerminalBinding(missed, source)).toBe('conflict');
  const accepting = frame(); accepting.status = 'failed'; accepting.receipt = undefined;
  expect(transportTerminalBinding(accepting, source)).toBe('incomplete');
  accepting.transport!.acceptanceId = undefined;
  expect(transportTerminalBinding(accepting, source)).toBe('incomplete');
  const noNamed = frame(); noNamed.status = 'failed'; noNamed.executionId = undefined;
  expect(transportTerminalBinding(noNamed, source)).toBe('incomplete');
});
const replySource = (): TransportDeliverySource => ({ kind: 'transport', deliveryId: 'moltnet:other' });

it('starts observation and waits for the matching arm before publishing once', async () => {
  let finish!: (value: TerminalEvidence) => void;
  const calls: unknown[] = [];
  let polls = 0;
  const request: NativeWorkerRequest = async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ path, body });
    if (body) return await new Promise<TerminalEvidence>(resolve => { finish = resolve; }) as T;
    const states = [{ state: 'idle' }, { state: 'waiting', wakeId: 'foreign', source },
      { state: 'waiting', wakeId: 'task', source: prefix }, { state: 'waiting', wakeId: 'task', source }];
    return states[Math.min(polls++, 3)] as T;
  };
  const publish = vi.fn(async () => { expect(polls).toBe(4); finish(frame()); });
  expect(await requestTransportDelivery(request, { wakeId: 'task', source }, { source, publish }, Date.now() + 1000, signal())).toMatchObject({ status: 'completed' });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(calls[0]).toEqual({ path: '/trial/run', body: { wakeId: 'task', source } });
});

it('accepts a matching prefix arm and never rewrites the prepared source', async () => {
  let finish!: (value: TerminalEvidence) => void;
  const request = (async (_path: string, body?: unknown) => body
    ? await new Promise<TerminalEvidence>(resolve => { finish = resolve; })
    : { state: 'observing', wakeId: 'task', source: prefix }) as NativeWorkerRequest;
  const publish = vi.fn(async () => { finish(frame(prefix)); });
  await requestTransportDelivery(request, { wakeId: 'task', source: prefix }, { source: prefix, publish }, Date.now() + 1000, signal());
  expect(publish).toHaveBeenCalledOnce();
});

it('never publishes a rejected or already-finished run', async () => {
  const delivery = prepared();
  const rejected = (async (_path: string, body?: unknown) => { if (body) throw new Error('Run refused'); return { state: 'idle' }; }) as NativeWorkerRequest;
  await expect(requestTransportDelivery(rejected, { wakeId: 'task', source }, delivery, Date.now() + 1000, signal())).rejects.toThrow('Run refused');
  const completed = (async (_path: string, body?: unknown) => body ? frame() : { state: 'waiting', wakeId: 'task', source }) as NativeWorkerRequest;
  expect(await requestTransportDelivery(completed, { wakeId: 'task', source }, delivery, Date.now() + 1000, signal())).toMatchObject({ status: 'completed' });
  expect(delivery.publish).not.toHaveBeenCalled();
});

it.each(['reject', 'hang'] as const)('requires publication success when terminal arrives before the publisher can %s', async kind => {
  let finish!: (value: TerminalEvidence) => void;
  const request = (async (_path: string, body?: unknown) => body
    ? await new Promise<TerminalEvidence>(resolve => { finish = resolve; })
    : { state: 'waiting', wakeId: 'task', source }) as NativeWorkerRequest;
  const publish = async () => {
    finish(frame());
    if (kind === 'hang') return await new Promise<void>(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    throw new Error('Publisher rejected after terminal');
  };
  await expect(requestTransportDelivery(request, { wakeId: 'task', source }, { source, publish }, Date.now() + 50, signal()))
    .rejects.toThrow(kind === 'hang' ? 'deadline' : 'Publisher rejected');
});

it.each(['arm', 'publish', 'failure'] as const)('cancels the request when %s cannot finish within the shared deadline', async phase => {
  let requestSignal: AbortSignal | undefined;
  const request = (async (_path: string, body?: unknown, _timeout?: number, current?: AbortSignal) => {
    if (!body) return phase === 'arm' ? { state: 'idle' } : { state: 'waiting', wakeId: 'task', source };
    requestSignal = current;
    return new Promise((_resolve, reject) => current!.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true }));
  }) as NativeWorkerRequest;
  const publish = vi.fn(async (): Promise<void> => { if (phase === 'failure') throw new Error('Publish failed'); return new Promise(() => undefined); });
  await expect(requestTransportDelivery(request, { wakeId: 'task', source }, { source, publish }, Date.now() + 40, signal()))
    .rejects.toThrow(phase === 'failure' ? 'Publish failed' : 'deadline');
  expect(requestSignal?.aborted).toBe(true);
  expect(publish).toHaveBeenCalledTimes(phase === 'arm' ? 0 : 1);
});

it.each(['deadline', 'cancel'] as const)('keeps %s active after publication succeeds, through terminal receipt', async kind => {
  vi.useFakeTimers();
  try {
    const cancelled = new AbortController();
    let requestSignal: AbortSignal | undefined;
    let finish!: (value: TerminalEvidence) => void;
    const request = (async (_path: string, body?: unknown, _timeout?: number, current?: AbortSignal) => {
      if (!body) return { state: 'waiting', wakeId: 'task', source };
      requestSignal = current;
      return new Promise<TerminalEvidence>(resolve => { finish = resolve; });
    }) as NativeWorkerRequest;
    const publish = vi.fn(async () => undefined);
    const result = requestTransportDelivery(request, { wakeId: 'task', source }, { source, publish }, Date.now() + 100, cancelled.signal);
    const rejected = expect(result).rejects.toThrow(kind === 'deadline' ? 'deadline' : 'cancelled');
    await vi.advanceTimersByTimeAsync(10);
    expect(publish).toHaveBeenCalledOnce();
    if (kind === 'deadline') await vi.advanceTimersByTimeAsync(100);
    else cancelled.abort();
    finish(frame()); // A late successful receipt cannot undo the refusal.
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('refuses late completion even when a blocked event loop has not fired the deadline timer', async () => {
  vi.useFakeTimers();
  try {
    const deadline = Date.now() + 100;
    await expect(boundedTransportCall(async () => { vi.setSystemTime(deadline); return frame(); }, deadline, signal())).rejects.toThrow('deadline');
  } finally { vi.useRealTimers(); }
});

it.each(['failed', 'completed'] as const)('returns %s evidence during terminal grace when work finished within its bound', async status => {
  vi.useFakeTimers();
  try {
    let finish!: (value: TerminalEvidence) => void;
    let requestSignal: AbortSignal | undefined;
    let requestTimeout: number | undefined;
    const request = (async (_path: string, body?: unknown, timeout?: number, current?: AbortSignal) => {
      if (!body) return { state: 'waiting', wakeId: 'task', source };
      requestSignal = current; requestTimeout = timeout;
      return new Promise<TerminalEvidence>(resolve => { finish = resolve; });
    }) as NativeWorkerRequest;
    const deadline = Date.now() + 100;
    const result = requestTransportDelivery(request, { wakeId: 'task', source }, prepared(), deadline, signal());
    await vi.advanceTimersByTimeAsync(50);
    const evidence = { ...frame(), status, error: 'Transport delivery deadline exceeded: no matching delivery arrived' };
    await vi.advanceTimersByTimeAsync(100);
    expect(requestTimeout).toBe(8100);
    expect(requestSignal?.aborted).toBe(false);
    if (status === 'failed') evidence.completedAt = new Date().toISOString();
    finish(evidence);
    expect(await result).toEqual(evidence);
  } finally { vi.useRealTimers(); }
});

it('still bounds a hung terminal by grace and never starts a run after its deadline', async () => {
  vi.useFakeTimers();
  try {
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn(async (_path: string, body?: unknown, _timeout?: number, current?: AbortSignal) => {
      if (!body) return { state: 'waiting', wakeId: 'task', source };
      requestSignal = current;
      return new Promise(() => undefined);
    }) as unknown as NativeWorkerRequest;
    await expect(requestTransportDelivery(request, { wakeId: 'task', source }, prepared(), Date.now(), signal())).rejects.toThrow('deadline');
    expect(request).not.toHaveBeenCalled();
    const result = requestTransportDelivery(request, { wakeId: 'task', source }, prepared(), Date.now() + 100, signal());
    const rejected = expect(result).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(8101);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
  } finally { vi.useRealTimers(); }
});

it.each(['late', 'absent', 'malformed'] as const)('refuses %s completion evidence even before the timeout callback runs', async kind => {
  vi.useFakeTimers();
  try {
    const deadline = Date.now() + 100;
    const request = (async (_path: string, body?: unknown) => {
      if (!body) return { state: 'waiting', wakeId: 'task', source };
      const evidence = frame();
      evidence.completedAt = kind === 'absent' ? undefined as unknown as string : kind === 'malformed' ? 'invalid' : new Date(deadline).toISOString();
      return evidence;
    }) as NativeWorkerRequest;
    await expect(requestTransportDelivery(request, { wakeId: 'task', source }, prepared(), deadline, signal())).rejects.toThrow('terminal completion evidence');
  } finally { vi.useRealTimers(); }
});
