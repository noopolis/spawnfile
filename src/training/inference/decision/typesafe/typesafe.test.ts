import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import type { DecisionRequest } from '../../../contracts/grading.js';
import { createTypeSafeDecision, createDecisionSpendBudget } from './index.js';

const key = 'FAKE_TYPESAFE_SECRET_123456';
const env = { TYPESAFE_API_KEY: key }, model = 'jev-1.13.0';
const request = (id = 'q', projection = {}): DecisionRequest => ({ key: id, type: 'yes-no', optionLabels: ['yes', 'no'],
  instructions: 'Does the statement follow from the evidence?', projection });
function responder(overrides: Record<string, unknown> = {}) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init!.body)) as { questions: Record<string, unknown> };
    return Response.json({ model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.8 }])),
      usage: { input_tokens: 100, output_tokens: 4 }, ...overrides });
  });
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('TypeSafe mapping and batching', () => {
  it('maps noul, choice and score with full instructions, scale order and a pinned identity', async () => {
    const fetch = responder({ answers: { yes: { type: 'noul', noul: 0.75 }, choice: { type: 'choice', probabilities: { a: 0.4, b: 0.6 } },
      score: { type: 'score', score: 1, legend: ['low', 'medium', 'high'], probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 } } } });
    const backend = createTypeSafeDecision({ model, env, fetch, pricePerMtokUsd: 0.5 });
    expect(await backend.identity()).toEqual({ backend: 'typesafe', model, endpoint: 'https://api.typesafe.ai/v1/systemone' });
    expect(fetch).not.toHaveBeenCalled();
    const inputs: DecisionRequest[] = [request('yes'), { ...request('choice'), type: 'choice', optionLabels: ['a', 'b'], system: 'Rubric' },
      { ...request('score'), type: 'score', optionLabels: [-1, 0, 1] }];
    const results = await backend.score(inputs);
    expect(results.every(result => result.providerRounded === true)).toBe(true);
    expect(results.map(result => result.probabilities)).toEqual([{ yes: 0.75, no: 0.25 }, { a: 0.4, b: 0.6 }, { '-1': 0.1, '0': 0.2, '1': 0.7 }]);
    const init = fetch.mock.calls[0]![1]!;
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
    expect(JSON.parse(String(init.body))).toEqual({ model, state: '{}', questions: {
      yes: { type: 'noul', instructions: inputs[0]!.instructions, criteria: { true: 'Yes', false: 'No' } },
      choice: { type: 'choice', instructions: `Rubric\n${inputs[1]!.instructions}`, criteria: { a: 'a', b: 'b' } },
      score: { type: 'score', instructions: inputs[2]!.instructions, criteria: ['Score -1', 'Score 0', 'Score 1'] },
    } });
    expect(backend.requestReceipts!()).toMatchObject([{ billing: 'api', inputTokens: 100, outputTokens: 4, usd: 0.00005, status: 200 }]);
    expect(backend.requestReceipts!()[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    expect(await backend.identity()).toMatchObject({ model });
  });
  it('groups identical states, splits at 64 questions, preserves order and accepts empty input', async () => {
    const fetch = responder(), backend = createTypeSafeDecision({ model, env, fetch });
    expect(await backend.score([])).toEqual([]);
    const requests = [request('other', { other: 1 }), ...Array.from({ length: 65 }, (_, i) => request(String(i)))];
    expect((await backend.score(requests)).map(r => r.key)).toEqual(requests.map(r => r.key));
    expect(fetch.mock.calls.map(([, init]) => Object.keys(JSON.parse(String(init!.body)).questions).length)).toEqual([1, 64, 1]);
  });
  it('splits by configurable token estimates and refuses oversized state or question without sending', async () => {
    const fetch = responder(), backend = createTypeSafeDecision({ model, env, fetch, maxEstimatedTokens: 90 });
    expect((await backend.score([request('a'), request('b')])).every(r => r.status === 'ok')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await backend.score([request('big', { text: 'x'.repeat(1000) })])).toMatchObject([{ status: 'missing', reason: 'TypeSafe token estimate limit' }]);
    const large = createTypeSafeDecision({ model, env, fetch });
    expect(await large.score([request('big', { text: 'x'.repeat(96_000) })])).toMatchObject([{ status: 'missing' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(large.score([request(), request()])).rejects.toThrow('Duplicate');
  });
  it.each([
    undefined, { type: 'noul' }, { type: 'noul', noul: -0.1 }, { type: 'noul', noul: '0.5' }, { type: 'choice', noul: 0.5 },
  ])('marks absent or invalid noul missing: %j', async answer => {
    const backend = createTypeSafeDecision({ model, env, fetch: responder({ answers: { q: answer } }) });
    expect(await backend.score([request()])).toMatchObject([{ status: 'missing', probabilities: null }]);
  });
  it.each([undefined, { a: 1 }, { a: 0.2, b: 0.2 }, { a: -1, b: 2 }, { a: 0.5, b: '0.5' }])('requires complete normalized choice probabilities: %j', async probabilities => {
    const backend = createTypeSafeDecision({ model, env, fetch: responder({ answers: { q: { type: 'choice', choice: 'a', probabilities } } }) });
    expect(await backend.score([{ ...request(), type: 'choice', optionLabels: ['a', 'b'] }])).toMatchObject([{ status: 'missing' }]);
  });
  it('requires score probabilities by index, not labels or scalar score', async () => {
    const backend = createTypeSafeDecision({ model, env, fetch: responder({ answers: { q: { type: 'score', score: 3, probabilities: { '2': 0.4, '3': 0.6 } } } }) });
    expect(await backend.score([{ ...request(), type: 'score', optionLabels: [2, 3] }])).toMatchObject([{ status: 'missing' }]);
  });
  it.each(['choice', 'score'] as const)('normalizes provider-rounded %s probabilities within inclusive limits', async type => {
    const optionLabels = type === 'choice' ? ['a', 'b', 'c'] : [-1, 0, 1];
    const keys = type === 'choice' ? optionLabels : ['0', '1', '2'];
    for (const values of [[0.33, 0.33, 0.33], [0.31, 0.33, 0.33], [0.37, 0.33, 0.33], [0.34, 0.33, 0.33],
      [0.06, 0.82, 0.09], [0.07, 0.56, 0.4]]) {
      const probabilities = Object.fromEntries(keys.map((label, i) => [label, values[i]]));
      const backend = createTypeSafeDecision({ model, env, fetch: responder({ answers: { q: { type, probabilities } } }) });
      const [result] = await backend.score([{ ...request(), type, optionLabels }]);
      expect(result).toMatchObject({ status: 'ok', providerRounded: true });
      const total = values.reduce((sum, value) => sum + value, 0);
      for (const [i, label] of optionLabels.entries()) expect(result!.probabilities![label]).toBeCloseTo(values[i]! / total, 14);
      expect(Object.values(result!.probabilities!).reduce((sum, p) => sum + p, 0)).toBeCloseTo(1, 14);
    }
  });
  it.each([[0.309, 0.33, 0.33], [0.371, 0.33, 0.33], [0.33, 0.33], [0, 0, 0], [1.01, 0, 0], [-0.01, 0.5, 0.5]])(
    'keeps invalid or partial provider distributions missing: %j', async (...values) => {
      const probabilities = Object.fromEntries(values.map((value, i) => [['a', 'b', 'c'][i], value]));
      const backend = createTypeSafeDecision({ model, env, fetch: responder({ answers: { q: { type: 'choice', probabilities } } }) });
      const [result] = await backend.score([{ ...request(), type: 'choice', optionLabels: ['a', 'b', 'c'] }]);
      expect(result).toMatchObject({ status: 'missing', probabilities: null });
      expect(result!.providerRounded).toBeUndefined();
    });
  it('validates typed option limits and full instruction presence', async () => {
    const backend = createTypeSafeDecision({ model, env, fetch: responder() });
    const invalid: DecisionRequest[] = [ { ...request(), key: '' }, { ...request(), instructions: ' ' },
      { ...request(), optionLabels: ['yes', 'yes'] }, { ...request(), optionLabels: ['yes', ''] },
      { ...request(), optionLabels: ['a', 'b'] }, { ...request(), optionLabels: ['yes'] },
      { ...request(), type: 'score', optionLabels: Array.from({ length: 11 }, (_, i) => i) },
      { ...request(), type: 'choice', optionLabels: Array.from({ length: 256 }, (_, i) => String(i)) } ];
    for (const item of invalid) await expect(backend.score([item])).rejects.toThrow('Invalid TypeSafe question');
  });
});

describe('TypeSafe transport safety', () => {
  it('reads only the selected environment at construction and refuses missing keys and aliases', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', key);
    const fetch = responder(), backend = createTypeSafeDecision({ model, fetch });
    vi.stubEnv('TYPESAFE_API_KEY', 'changed');
    await backend.score([request()]);
    expect(fetch.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: `Bearer ${key}` });
    for (const value of [undefined, '', ' ']) expect(() => createTypeSafeDecision({ model, env: { TYPESAFE_API_KEY: value } })).toThrow('requires TYPESAFE_API_KEY');
    expect(() => createTypeSafeDecision({ model: 'jev-latest', env })).toThrow('pinned');
    for (const endpoint of ['bad', 'ftp://host', 'http://u:p@host', 'http://host?q=x', 'http://host#x', `http://host/${key}`]) {
      expect(() => createTypeSafeDecision({ model, env, endpoint })).toThrow('Invalid TypeSafe endpoint');
    }
    for (const options of [{ pricePerMtokUsd: NaN }, { pricePerMtokUsd: -1 }, { maxAttempts: 0 }, { maxAttempts: 11 },
      { timeoutMs: 0 }, { retryBaseMs: -1 }, { maxEstimatedTokens: 0 }, { maxEstimatedTokens: 64_001 }]) {
      expect(() => createTypeSafeDecision({ model, env, ...options })).toThrow('Invalid TypeSafe');
    }
    expect(() => createDecisionSpendBudget(-1)).toThrow('Invalid maximum');
  });
  it('returns bounded missing reasons for 422, never an echoed secret or response body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ detail: `Authorization: Bearer ${key}` }), { status: 422 }));
    const backend = createTypeSafeDecision({ model, env, fetch });
    const results = await backend.score([request('a'), request('b')]);
    expect(results).toMatchObject([{ reason: 'TypeSafe HTTP 422: request rejected' }, { status: 'missing' }]);
    expect(inspect({ results, receipts: backend.requestReceipts!() }, { depth: null })).not.toContain(key);
    expect(JSON.stringify(backend)).not.toContain(key);
  });
  it('never exposes the key in thrown errors (including causes), identity or receipts', async () => {
    const failures: typeof fetch[] = [async () => { throw new Error(`Authorization: Bearer ${key}`); },
      async () => new Response(key, { status: 401 }), async () => new Response(key),
      async () => Response.json({ model: key, diagnostic: key }),
      async () => Response.json({ model, usage: { input_tokens: key, output_tokens: key } })];
    for (const fetch of failures) {
      const backend = createTypeSafeDecision({ model, env, fetch, retryBaseMs: 0 });
      let output: unknown;
      try { output = await backend.score([request()]); } catch (error) { output = error; }
      expect(inspect({ output, receipts: backend.requestReceipts!() }, { depth: null })).not.toContain(key);
      expect(JSON.stringify({ output, receipts: backend.requestReceipts!() })).not.toContain(key);
    }
    const backend = createTypeSafeDecision({ model, env, fetch: async () => new Response(key, { status: 401 }) });
    await expect(backend.score([request()])).rejects.toThrow('authentication failed (401)');
  });
  it('retries 429 and 5xx with exponential jitter, and exhausts 529 as infrastructure failure', async () => {
    const fetch = responder();
    fetch.mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response('', { status: 503 }));
    const backend = createTypeSafeDecision({ model, env, fetch, retryBaseMs: 2 });
    const operation = backend.score([request()]);
    expect((await operation)[0]!.status).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(backend.requestReceipts!().map(r => r.status)).toEqual([429, 503, 200]);
    const overloaded = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 529 }));
    const failed = createTypeSafeDecision({ model, env, fetch: overloaded, retryBaseMs: 0 });
    const assertion = expect(failed.score([request()])).rejects.toThrow('retry attempts exhausted');
    await assertion;
    expect(overloaded).toHaveBeenCalledTimes(3);
  });
  it('permanently refuses changed or omitted model identity without canaries', async () => {
    const fetch = responder({ model: 'jev-1.14.0' }), backend = createTypeSafeDecision({ model, env, fetch });
    await expect(backend.score([request()])).rejects.toThrow('differs from pinned');
    await expect(backend.identity()).rejects.toThrow('differs from pinned');
    await expect(backend.score([request()])).rejects.toThrow('differs from pinned');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(createTypeSafeDecision({ model, env, fetch: responder({ model: null }) }).score([request()])).rejects.toThrow('differs from pinned');
  });
  it('honors abort before scoring and during request/backoff, stripping abort reasons', async () => {
    const controller = new AbortController(); controller.abort(new Error(key));
    const backend = createTypeSafeDecision({ model, env, fetch: responder() });
    await expect(backend.identity(controller.signal)).rejects.toThrow('cancelled');
    await expect(backend.score([request()], controller.signal)).rejects.toThrow('cancelled');
    const running = new AbortController();
    const cancelled = createTypeSafeDecision({ model, env, fetch: async () => { running.abort(key); throw new Error(key); } });
    await expect(cancelled.score([request()], running.signal)).rejects.toThrow('cancelled');
    const waiting = new AbortController();
    const retry = createTypeSafeDecision({ model, env, retryBaseMs: 1, fetch: async () => {
      setTimeout(() => waiting.abort(key), 0); return new Response('', { status: 429 });
    } });
    await expect(retry.score([request()], waiting.signal)).rejects.toThrow('cancelled');
    const timed = createTypeSafeDecision({ model, env, timeoutMs: 5, retryBaseMs: 0, fetch: async (_url, init) => {
      await new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error(key))));
      throw new Error(key);
    } });
    await expect(timed.score([request()])).rejects.toThrow('retry attempts exhausted');
  });
});

describe('TypeSafe spend reservations', () => {
  it('spend cap stops sending, uses measured spend, and marks every withheld instance missing', async () => {
    const fetch = responder(), backend = createTypeSafeDecision({ model, env, fetch, pricePerMtokUsd: 1, maxSpendUsd: 0.00015 });
    const results = await backend.score([request('first', { state: 1 }), request('second', { state: 2 }), request('third', { state: 2 })]);
    expect(results).toMatchObject([{ status: 'ok' }, { status: 'missing', reason: 'spend cap' }, { status: 'missing', reason: 'spend cap' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const zero = createTypeSafeDecision({ model, env, fetch, maxSpendUsd: 0 });
    expect(await zero.score([request()])).toMatchObject([{ reason: 'spend cap' }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reserves across concurrent backends and keeps unknown usage reserved', async () => {
    const budget = createDecisionSpendBudget(0.0001), fetch = responder({ usage: {} });
    const a = createTypeSafeDecision({ model, env, fetch, pricePerMtokUsd: 1, budget });
    const b = createTypeSafeDecision({ model, env, fetch, pricePerMtokUsd: 1, budget });
    const results = await Promise.all([a.score([request()]), b.score([request()])]);
    expect(results.flat().filter(r => r.reason === 'spend cap')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(budget.reservedUsd).toBeGreaterThan(0);
    expect(budget.spentUsd).toBe(0);
    expect(a.requestReceipts!()[0]).toMatchObject({ inputTokens: null, outputTokens: null, usd: null });
  });
});
