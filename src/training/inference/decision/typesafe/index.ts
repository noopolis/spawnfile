import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../../contracts/grading.js';
import { typeSafeTransport, type TypeSafeTransportOptions } from './transport.js';
import { decode, estimatedTokens, missing, payload, question } from './wire.js';

export { createDecisionSpendBudget, TYPESAFE_ENDPOINT } from './transport.js';
export interface TypeSafeDecisionOptions extends TypeSafeTransportOptions { maxEstimatedTokens?: number }

/** Hosted Jev: explicit API billing; identity never spends money on canaries. */
export function createTypeSafeDecision(options: TypeSafeDecisionOptions): DecisionBackend {
  const transport = typeSafeTransport(options);
  const limit = options.maxEstimatedTokens ?? 48_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000) throw new Error('Invalid TypeSafe token estimate limit');
  return {
    capabilities: { billing: 'api', batch: true },
    identity: async signal => transport.identity(signal),
    requestReceipts: transport.receipts,
    async score(requests, signal) {
      transport.identity(signal);
      const deadline = AbortSignal.timeout(transport.timeout);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const groups = new Map<string, DecisionRequest[]>();
      const results = new Map<string, DecisionResult>();
      for (const request of requests) {
        question(request);
        if (results.has(request.key)) throw new Error('Duplicate TypeSafe question key');
        results.set(request.key, missing(request, 'TypeSafe token estimate limit'));
        // Independently enforce state + longest question <= 32k; never truncate.
        if (estimatedTokens(options.model, [request]) > Math.min(limit, 32_000)) continue;
        const state = JSON.stringify(request.projection);
        const group = groups.get(state) ?? [];
        group.push(request); groups.set(state, group);
      }
      const send = async (batch: DecisionRequest[]) => {
        const response = await transport.send(payload(options.model, batch), estimatedTokens(options.model, batch), combined);
        const answers = (response.data as { answers?: Record<string, unknown> } | undefined)?.answers;
        for (const request of batch) results.set(request.key, response.reason
          ? missing(request, response.reason) : decode(request, answers?.[request.key]));
      };
      for (const group of groups.values()) {
        let batch: DecisionRequest[] = [];
        for (const request of group) {
          if (batch.length && (batch.length === 64 || estimatedTokens(options.model, [...batch, request]) > limit)) {
            await send(batch); batch = [];
          }
          batch.push(request);
        }
        await send(batch);
      }
      return requests.map(request => results.get(request.key)!);
    },
  };
}
