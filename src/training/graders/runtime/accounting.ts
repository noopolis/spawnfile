import { randomUUID } from 'node:crypto';
import type { DecisionAccounting, DecisionBackend, DecisionRequestReceipt } from '../../contracts/grading.js';

/** Current invocation only: cached scores are not new billable requests. */
export function summarizeDecisionAccounting(receipts: DecisionRequestReceipt[]): DecisionAccounting {
  // Compatibility for injected backends: this invocation owns these dispatched
  // receipts. Assign once before the grade can be cloned, persisted or reused.
  for (const receipt of receipts) receipt.requestId ??= randomUUID();
  const sum = (field: 'inputTokens' | 'outputTokens' | 'usd') => receipts.some(receipt => receipt[field] === null)
    ? null : receipts.reduce((total, receipt) => total + receipt[field]!, 0);
  const latencies = receipts.map(receipt => receipt.latencyMs).sort((a, b) => a - b);
  const percentile = (p: number) => latencies.length ? latencies[Math.ceil(p * latencies.length) - 1]! : null;
  return { billing: 'api', requests: receipts.length, inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    usd: sum('usd'), latencyMs: { p50: percentile(0.5), p95: percentile(0.95) }, receipts };
}

/** Failure data excludes diagnostics, request bodies and provider response extensions. */
export class DecisionAccountingError extends Error {
  constructor(cause: unknown, readonly decisionAccounting: DecisionAccounting) {
    super(cause instanceof Error ? cause.message : 'Decision operation failed', { cause });
    this.name = 'DecisionAccountingError';
  }
}

/** Register each backend before calling it; await drained provider work before rejection. */
export async function withDecisionFailureAccounting<T>(backends: Set<DecisionBackend>, receipts: DecisionRequestReceipt[], operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (cause) {
    const paid = [...backends].filter(backend => backend.capabilities?.billing === 'api');
    if (!paid.length) throw cause;
    const allowed = receipts.map(receipt => ({
      ...(receipt.requestId === undefined ? {} : { requestId: receipt.requestId }),
      billing: receipt.billing, model: receipt.model, endpoint: receipt.endpoint,
      inputTokens: receipt.inputTokens, outputTokens: receipt.outputTokens, usd: receipt.usd,
      estimatedInputTokens: receipt.estimatedInputTokens, estimatedUsd: receipt.estimatedUsd,
      latencyMs: receipt.latencyMs, status: receipt.status,
    }));
    throw new DecisionAccountingError(cause, summarizeDecisionAccounting(allowed));
  }
}
