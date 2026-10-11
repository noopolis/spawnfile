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
