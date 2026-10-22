import { expect, it, vi } from 'vitest';
import { createDecisionSpendBudget, createTypeSafeDecision } from './index.js';
import type { DecisionRequest } from '../../../contracts/grading.js';

const model = 'jev-1.0.0', env = { TYPESAFE_API_KEY: 'offline-key' };
const request: DecisionRequest = { key: 'q', type: 'noul', optionLabels: ['true', 'false'], expectedOptions: ['true'], instructions: 'Supported?', projection: {} };
it('maps strict true/false Noul decisions and refuses incompatible label vocabularies', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    expect(body.questions.q.type).toBe('noul');
    expect(body.questions.q.criteria).toEqual({ true: 'Yes', false: 'No' });
    return Response.json({ model, answers: { q: { type: 'noul', noul: 0.85 } } });
  });
  const backend = createTypeSafeDecision({ model, env, fetch });
  const [scored] = await backend.score([request]);
  expect(scored!.status).toBe('ok'); expect(scored!.probabilities!.true).toBe(0.85); expect(scored!.probabilities!.false).toBeCloseTo(0.15);
  await expect(backend.score([{ ...request, optionLabels: ['yes', 'no'] }])).rejects.toThrow('Invalid TypeSafe question');
});

it('keeps unknown-usage admission charges across calls and retries, while actual spend stays unknown', async () => {
  const budget = createDecisionSpendBudget(0.00008);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ model, answers: { q: { type: 'noul', noul: 1 } } }));
  const backend = createTypeSafeDecision({ model, env, fetch, budget, conservativeSpend: true, pricePerMtokUsd: 1 });
  expect((await backend.score([request]))[0]!.status).toBe('ok');
  const charged = budget.spentUsd;
  expect(charged).toBeGreaterThan(0);
  expect(backend.requestReceipts!()[0]!.usd).toBeNull();
  expect((await backend.score([request]))[0]).toMatchObject({ status: 'missing', reason: 'spend cap', failureCause: 'spend-cap' });
  expect(fetch).toHaveBeenCalledTimes(1); expect(budget.reservedUsd).toBe(0);
  const retryBudget = createDecisionSpendBudget(0.00008);
  const retry = vi.fn<typeof globalThis.fetch>(async () => new Response('', { status: 503 }));
  const retryBackend = createTypeSafeDecision({ model, env, fetch: retry, budget: retryBudget, conservativeSpend: true, pricePerMtokUsd: 1, retryBaseMs: 0 });
  expect((await retryBackend.score([request]))[0]).toMatchObject({ status: 'missing', reason: 'spend cap', failureCause: 'spend-cap' });
  expect(retry).toHaveBeenCalledTimes(1); expect(retryBudget.spentUsd).toBe(charged); expect(retryBudget.reservedUsd).toBe(0);
});

it('charges the greater of estimated and measured usage without inventing receipt usage', async () => {
  const budget = createDecisionSpendBudget(1);
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ model, usage: { input_tokens: 2000 }, answers: { q: { type: 'noul', noul: 1 } } }));
  const backend = createTypeSafeDecision({ model, env, fetch, budget, conservativeSpend: true, pricePerMtokUsd: 1 });
  await backend.score([request]);
  expect(budget.spentUsd).toBe(0.002);
  expect(backend.requestReceipts!()[0]!.usd).toBe(0.002);
});

it('retains typed admission refusal at a zero cap without a dispatched receipt', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const backend = createTypeSafeDecision({ model, env, fetch, maxSpendUsd: 0, conservativeSpend: true });
  const receipts: import('../../../contracts/grading.js').DecisionRequestReceipt[] = [];
  expect(await backend.score([request], undefined, receipts)).toEqual([
    { key: 'q', status: 'missing', probabilities: null, reason: 'spend cap', failureCause: 'spend-cap' },
  ]);
  expect(fetch).not.toHaveBeenCalled(); expect(receipts).toEqual([]);
});


it.each([400, 403, 404, 413, 422])('retains a typed sanitized HTTP %i refusal without retrying', async status => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(env.TYPESAFE_API_KEY, { status }));
  const budget = createDecisionSpendBudget(1);
  const backend = createTypeSafeDecision({ model, env, fetch, budget });
  expect(await backend.score([request])).toEqual([{ key: 'q', status: 'missing', probabilities: null,
    reason: `TypeSafe HTTP ${status}: request rejected`, failureCause: 'request-rejected' }]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(budget.reservedUsd).toBe(0);
  expect(backend.requestReceipts!()).toMatchObject([{ status, usd: null }]);
  expect(JSON.stringify(backend.requestReceipts!())).not.toContain(env.TYPESAFE_API_KEY);
});
