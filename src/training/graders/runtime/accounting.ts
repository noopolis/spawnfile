import type { DecisionAccounting, DecisionRequestReceipt } from '../../contracts/grading.js';

/** Current invocation only: cached scores are not new billable requests. */
export function summarizeDecisionAccounting(receipts: DecisionRequestReceipt[]): DecisionAccounting {
  const sum = (field: 'inputTokens' | 'outputTokens' | 'usd') => receipts.some(receipt => receipt[field] === null)
    ? null : receipts.reduce((total, receipt) => total + receipt[field]!, 0);
  const latencies = receipts.map(receipt => receipt.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1]! : null;
  return { billing: 'api', requests: receipts.length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    usd: sum('usd'), latencyMs: { p50: percentile(0.5), p95: percentile(0.95) }, receipts };
}
