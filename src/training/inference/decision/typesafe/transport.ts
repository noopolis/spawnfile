import { assertModelRequestAdmission } from '../../request-cap.js';
import { reserveEvaluatorRequest, typeSafeEvaluatorEnvironment } from '../../evaluator/index.js';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { DecisionRequestReceipt, DecisionSpendBudget, DecisionResult } from '../../../contracts/grading.js';

export interface TypeSafeTransportOptions {
  model: string;
  /** Admission ledger charges at least the estimate per attempt when usage is unknown. */
  conservativeSpend?: boolean;
  endpoint?: string;
  pricePerMtokUsd?: number;
  maxSpendUsd?: number;
  budget?: DecisionSpendBudget;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
  env?: Readonly<Record<string, string | undefined>>;
}
export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export function createDecisionSpendBudget(maxUsd?: number): DecisionSpendBudget {
  if (maxUsd !== undefined && (!Number.isFinite(maxUsd) || maxUsd < 0)) throw new Error('Invalid maximum spend USD');
  return { maxUsd, spentUsd: 0, reservedUsd: 0 };
}

export function typeSafeTransport(options: TypeSafeTransportOptions) {
  assertModelRequestAdmission('typesafe', 'decisions', { purpose: 'decisions', model: options.model });
  const key = (typeSafeEvaluatorEnvironment() ?? options.env ?? process.env).TYPESAFE_API_KEY;
  if (!key?.trim()) throw new Error('TypeSafe requires TYPESAFE_API_KEY');
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint ?? TYPESAFE_ENDPOINT); }
  catch { throw new Error('Invalid TypeSafe endpoint'); }
  const evaluatorCapped = process.env.PAIDEIA_MODEL_REQUEST_CAP === 'broker' || process.env.PAIDEIA_EVALUATOR_ROUTES_FILE !== undefined;
  if (evaluatorCapped && endpoint.href !== TYPESAFE_ENDPOINT) {
    throw new Error('Capped TypeSafe evaluator requires the declared hosted endpoint');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || endpoint.href.includes(key)) throw new Error('Invalid TypeSafe endpoint');
  if (!/^jev-\d+\.\d+\.\d+$/.test(options.model) || options.model.includes(key)) throw new Error('TypeSafe requires a pinned versioned model');
  // Configurable estimate, never a claim about the current provider price or invoice.
  const price = options.pricePerMtokUsd ?? 0.042;
  const attempts = options.maxAttempts ?? 3, timeout = options.timeoutMs ?? 180_000, base = options.retryBaseMs ?? 250;
  if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10 ||
    !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647 || !Number.isSafeInteger(base) || base < 0 || base > 60_000) {
    throw new Error('Invalid TypeSafe transport options');
  }
  const budget = options.budget ?? createDecisionSpendBudget(options.maxSpendUsd);
  const receipts: DecisionRequestReceipt[] = [];
  let drifted = false;
  const check = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('TypeSafe request cancelled or timed out');
    if (drifted) throw new Error('TypeSafe response model differs from pinned model');
  };
  return {
    receipts: () => receipts.map(receipt => ({ ...receipt })),
    identity(signal?: AbortSignal) {
      check(signal);
      return { backend: 'typesafe', model: options.model, endpoint: endpoint.href };
    },
    async send(body: unknown, tokens: number, signal?: AbortSignal, collector?: DecisionRequestReceipt[]): Promise<{ data?: unknown; reason?: string; failureCause?: DecisionResult['failureCause'] }> {
      check(signal);
      const estimate = tokens * price / 1e6;
      if (budget.maxUsd === 0 || (budget.maxUsd !== undefined && budget.spentUsd + budget.reservedUsd + estimate > budget.maxUsd)) return { reason: 'spend cap', failureCause: 'spend-cap' };
      budget.reservedUsd += estimate;
      try {
        for (let attempt = 0; attempt < attempts; attempt++) {
          check(signal);
          if (options.conservativeSpend && budget.maxUsd !== undefined && budget.spentUsd + budget.reservedUsd > budget.maxUsd) return { reason: 'spend cap', failureCause: 'spend-cap' };
          const admission = evaluatorCapped
            ? reserveEvaluatorRequest('typesafe', 'decisions', options.model, estimate) : undefined;
          const receipt: DecisionRequestReceipt = { requestId: admission?.id ?? randomUUID(), billing: 'api', model: options.model, endpoint: endpoint.href,
            inputTokens: null, outputTokens: null, usd: null, estimatedInputTokens: tokens, estimatedUsd: estimate,
            latencyMs: 0, status: null };
          const start = performance.now();
          const deadline = new AbortController();
          const timer = setTimeout(() => deadline.abort(), timeout);
          const attemptSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
          let response: Response | undefined;
          try {
            // No request capture: Authorization exists only at this transport boundary.
            response = await (options.fetch ?? fetch)(endpoint.href, { method: 'POST', redirect: 'error', signal: attemptSignal,
              headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
            attemptSignal.throwIfAborted();
            receipt.status = response.status;
            if (response.status === 401) throw new Error('TypeSafe authentication failed (401)');
            if (response.status === 402) throw new Error('TypeSafe payment failed (402)');
            const retry = response.status === 429 || response.status >= 500;
            if (!retry && !response.ok) return { reason: `TypeSafe HTTP ${response.status}: request rejected`, failureCause: 'request-rejected' };
            if (!retry) {
              const raw: unknown = await response.json();
              attemptSignal.throwIfAborted();
              const data = raw as { model?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
              const input = data?.usage?.input_tokens, output = data?.usage?.output_tokens;
              if (typeof input === 'number' && Number.isSafeInteger(input) && input >= 0) {
                receipt.inputTokens = input; receipt.usd = input * price / 1e6;
                if (!options.conservativeSpend) budget.spentUsd += receipt.usd;
              }
              if (typeof output === 'number' && Number.isSafeInteger(output) && output >= 0) receipt.outputTokens = output;
              if (data?.model !== options.model) { drifted = true; check(); }
              return { data: raw };
            }
          } catch {
            // Never propagate fetch/JSON/abort errors: they may embed Authorization or echoed credentials.
            check(signal);
            if (receipt.status === 401) throw new Error('TypeSafe authentication failed (401)');
            if (receipt.status === 402) throw new Error('TypeSafe payment failed (402)');
            // Network errors and this attempt's timeout share the bounded 5xx retry policy.
            // Caller cancellation, authentication, payment and model drift remain terminal.
          } finally {
            // Release unread error bodies before returning or admitting another attempt.
            // Aborting also closes a fetch body whose reader failed or was interrupted.
            deadline.abort();
            if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
            clearTimeout(timer);
            if (options.conservativeSpend) budget.spentUsd += Math.max(estimate, receipt.usd ?? 0);
            receipt.latencyMs = performance.now() - start;
            receipts.push(receipt);
            collector?.push({ ...receipt });
            admission?.finish(receipt.status !== null && receipt.status >= 200 && receipt.status < 300 ? 'completed' : 'failed', receipt);
          }
          if (attempt + 1 === attempts) throw new Error('TypeSafe infrastructure failure: retry attempts exhausted');
          try { await delay(base * 2 ** attempt * (1 + Math.random()), undefined, { signal }); }
          catch { throw new Error('TypeSafe request cancelled or timed out'); }
        }
        throw new Error('TypeSafe infrastructure failure');
      } finally {
        budget.reservedUsd -= estimate;
      }
    },
  };
}
