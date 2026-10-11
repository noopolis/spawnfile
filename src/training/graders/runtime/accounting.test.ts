import { expect, it } from 'vitest';
import { summarizeDecisionAccounting } from './accounting.js';
import type { DecisionRequestReceipt } from '../../contracts/grading.js';

it('aggregates measured accounting, nearest-rank latency percentiles and unknown usage honestly', () => {
  const receipt: DecisionRequestReceipt = { billing: 'api', model: 'jev-1.13.0', endpoint: 'https://example.test',
    inputTokens: 100, outputTokens: 5, usd: 0.2, estimatedInputTokens: 80, estimatedUsd: 0.16, latencyMs: 10, status: 200 };
  expect(summarizeDecisionAccounting([receipt, { ...receipt, latencyMs: 30 }])).toMatchObject({ requests: 2,
    inputTokens: 200, outputTokens: 10, usd: 0.4, latencyMs: { p50: 10, p95: 30 } });
  expect(summarizeDecisionAccounting([{ ...receipt, inputTokens: null, outputTokens: null, usd: null }])).toMatchObject({ inputTokens: null, outputTokens: null, usd: null });
  expect(summarizeDecisionAccounting([])).toMatchObject({ requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, latencyMs: { p50: null, p95: null } });
});

it('retains only current paid receipts and their allowed fields on failure', async () => {
  const { withDecisionFailureAccounting, DecisionAccountingError } = await import('./accounting.js');
  const { vi } = await import('vitest');
  const receipt: DecisionRequestReceipt = { billing: 'api', model: 'm', endpoint: 'https://example.test',
    inputTokens: 100, outputTokens: 0, usd: 0.1, estimatedInputTokens: 80, estimatedUsd: 0.08, latencyMs: 10, status: 200 };
  const receipts = [receipt];
  const backend = { capabilities: { billing: 'api' as const }, requestReceipts: () => receipts,
    identity: vi.fn(), score: vi.fn() };
  const cause = new Error('diagnostic');
  const failure = await withDecisionFailureAccounting(new Map([[backend, 1]]), async () => {
    receipts.push({ ...receipt, Authorization: 'secret' } as DecisionRequestReceipt);
    throw cause;
  }).catch(error => error as InstanceType<typeof DecisionAccountingError>);
  expect(failure).toBeInstanceOf(DecisionAccountingError);
  expect(failure.cause).toBe(cause);
  expect(failure.decisionAccounting).toMatchObject({ requests: 1, inputTokens: 100, usd: 0.1, receipts: [receipt] });
  expect(JSON.stringify(failure.decisionAccounting)).not.toContain('secret');
  expect(await withDecisionFailureAccounting(new Map(), async () => 'done')).toBe('done');
  await expect(withDecisionFailureAccounting(new Map(), async () => { throw cause; })).rejects.toBe(cause);
  await expect(withDecisionFailureAccounting(new Map([[{ ...backend, requestReceipts: undefined }, 0]]), async () => {
    throw 'untyped failure';
  })).rejects.toMatchObject({ message: 'Decision operation failed', decisionAccounting: { requests: 0 } });
});
