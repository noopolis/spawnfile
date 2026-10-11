import { expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { DecisionRequest } from '../../../contracts/grading.js';
import { createTypeSafeDecision, createDecisionSpendBudget } from './index.js';

const model = 'jev-1.13.0', env = { TYPESAFE_API_KEY: 'fake-dispatch-secret' };
const requests = (count: number): DecisionRequest[] => Array.from({ length: count }, (_, i) => ({
  key: String(i), type: 'yes-no', optionLabels: ['yes', 'no'], instructions: 'Is this supported?', projection: { i },
}));
function response(init?: RequestInit, usage = { input_tokens: 10, output_tokens: 1 }) {
  const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
  return Response.json({ model, answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.9 }])), usage });
}

it('completes 1,000 groups with 1ms fetches and a fresh 50ms timeout, using eight default workers', async () => {
  let active = 0, peak = 0;
  const signals = new Set<AbortSignal>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    active++; peak = Math.max(peak, active); signals.add(init!.signal!);
    try { await delay(1, undefined, { signal: init!.signal! }); return response(init); }
    finally { active--; }
  });
  const backend = createTypeSafeDecision({ model, env, fetch, timeoutMs: 50, maxAttempts: 1 });
  const input = requests(1000), output = await backend.score(input);
  expect(output.map(result => result.key)).toEqual(input.map(request => request.key));
  expect(output.every(result => result.status === 'ok')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1000);
  expect(signals.size).toBe(1000);
  expect(peak).toBe(8);
  expect(active).toBe(0);
  expect(backend.requestReceipts!()).toHaveLength(1000);
});

it.each([1, 3, 32])('bounds the configured pool at %i concurrent groups', async concurrency => {
  let active = 0, peak = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    active++; peak = Math.max(peak, active);
    await delay(1); active--; return response(init);
  };
  const backend = createTypeSafeDecision({ model, env, fetch, concurrency });
  expect((await backend.score(requests(40))).every(result => result.status === 'ok')).toBe(true);
  expect(peak).toBe(concurrency);
});

it.each([0, -1, 1.5, 33, NaN, Infinity])('rejects invalid concurrency %s', concurrency => {
  expect(() => createTypeSafeDecision({ model, env, concurrency })).toThrow('Invalid TypeSafe concurrency');
});

it('times out only the hung attempt and retries it while other groups complete', async () => {
  const counts = new Map<string, number>(), completed: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const key = Object.keys(JSON.parse(String(init!.body)).questions)[0]!;
    const attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
    if (key === '0' && attempt === 1) await delay(10_000, undefined, { signal: init!.signal! });
    completed.push(key); return response(init);
  });
  const backend = createTypeSafeDecision({ model, env, fetch, timeoutMs: 10, retryBaseMs: 0 });
  expect((await backend.score(requests(3))).every(result => result.status === 'ok')).toBe(true);
  expect(counts).toEqual(new Map([['0', 2], ['1', 1], ['2', 1]]));
  expect(completed).toEqual(['1', '2', '0']);
  expect(backend.requestReceipts!().filter(receipt => receipt.status === null)).toHaveLength(1);
});

it('exhausts isolated request timeouts and retains a receipt and reservation for every attempt', async () => {
  const budget = createDecisionSpendBudget();
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    await delay(10_000, undefined, { signal: init!.signal! }); return response(init);
  });
  const backend = createTypeSafeDecision({ model, env, fetch, timeoutMs: 5, retryBaseMs: 0, maxAttempts: 2, budget });
  await expect(backend.score(requests(1))).rejects.toThrow('infrastructure failure: retry attempts exhausted');
  expect(fetch).toHaveBeenCalledTimes(2);
  const receipts = backend.requestReceipts!();
  expect(receipts.map(receipt => receipt.status)).toEqual([null, null]);
  expect(budget.reservedUsd).toBeCloseTo(receipts.reduce((sum, receipt) => sum + receipt.estimatedUsd, 0), 12);
});

it('retries network failures with backoff and fresh signals, then fails closed on exhaustion', async () => {
  const start: number[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    start.push(performance.now());
    if (start.length < 3) throw new Error(env.TYPESAFE_API_KEY);
    return response(init);
  });
  const backend = createTypeSafeDecision({ model, env, fetch, retryBaseMs: 10 });
  expect((await backend.score(requests(1)))[0]!.status).toBe('ok');
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(start[1]! - start[0]!).toBeGreaterThanOrEqual(8);
  expect(start[2]! - start[1]!).toBeGreaterThanOrEqual(18);
  expect(new Set(fetch.mock.calls.map(([, init]) => init!.signal)).size).toBe(3);
  const failing = vi.fn<typeof globalThis.fetch>(async () => { throw new Error(env.TYPESAFE_API_KEY); });
  const failed = createTypeSafeDecision({ model, env, fetch: failing, retryBaseMs: 0, maxAttempts: 2 });
  await expect(failed.score(requests(1))).rejects.toThrow('infrastructure failure: retry attempts exhausted');
  expect(failing).toHaveBeenCalledTimes(2);
  expect(failed.requestReceipts!()).toHaveLength(2);
});

it('applies the timeout through body reading, then retries with a fresh attempt', async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const result = response(init);
    if (++calls === 1) result.json = async () => {
      await delay(10_000, undefined, { signal: init!.signal! }); return {};
    };
    return result;
  };
  const backend = createTypeSafeDecision({ model, env, fetch, timeoutMs: 5, retryBaseMs: 0 });
  expect((await backend.score(requests(1)))[0]!.status).toBe('ok');
  expect(calls).toBe(2);
  expect(backend.requestReceipts!().map(receipt => receipt.status)).toEqual([200, 200]);
});

it('stops queued groups and drains cancelled siblings before returning a terminal failure', async () => {
  let settled = false;
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const key = Object.keys(JSON.parse(String(init!.body)).questions)[0];
    if (key === '0') { await delay(1); return new Response('', { status: 401 }); }
    try { await delay(10_000, undefined, { signal: init!.signal! }); return response(init); }
    finally { await delay(5); settled = true; }
  });
  const backend = createTypeSafeDecision({ model, env, fetch, concurrency: 2 });
  await expect(backend.score(requests(10))).rejects.toThrow('authentication failed');
  expect(settled).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(backend.requestReceipts!()).toHaveLength(2);
});

it('reserves before every concurrent dispatch, replaces only measured usage, and shares the cap across calls', async () => {
  const budget = createDecisionSpendBudget(0.0002);
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    expect(budget.spentUsd + budget.reservedUsd).toBeLessThanOrEqual(budget.maxUsd!);
    await delay(2); return response(init);
  });
  const backend = createTypeSafeDecision({ model, env, fetch, pricePerMtokUsd: 1, budget });
  const [first, second] = await Promise.all([backend.score(requests(20)), backend.score(requests(20))]);
  const receipts = backend.requestReceipts!();
  expect(receipts.length).toBeGreaterThan(0);
  expect(receipts.length).toBeLessThan(8);
  expect(first.concat(second).filter(result => result.reason === 'spend cap')).toHaveLength(40 - receipts.length);
  expect(budget.spentUsd).toBeCloseTo(receipts.length * 0.00001, 12);
  expect(budget.reservedUsd).toBeCloseTo(0, 12);
});

it('requires HTTPS before any credential-bearing dispatch', () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(() => createTypeSafeDecision({ model, env, fetch, endpoint: 'http://remote.example/v1/systemone' })).toThrow('Invalid TypeSafe endpoint');
  expect(fetch).not.toHaveBeenCalled();
});

it('refuses zero paid prices and blocks a zero cap independently even when the estimate underflows', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(() => createTypeSafeDecision({ model, env, fetch, maxSpendUsd: 0, pricePerMtokUsd: 0 })).toThrow('Invalid TypeSafe transport options');
  const backend = createTypeSafeDecision({ model, env, fetch, maxSpendUsd: 0, pricePerMtokUsd: Number.MIN_VALUE });
  expect(await backend.score(requests(2))).toMatchObject([{ reason: 'spend cap' }, { reason: 'spend cap' }]);
  expect(fetch).not.toHaveBeenCalled();
  expect(backend.requestReceipts!()).toEqual([]);
});
