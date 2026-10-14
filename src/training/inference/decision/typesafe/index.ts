import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../../contracts/grading.js';
import { typeSafeTransport, type TypeSafeTransportOptions } from './transport.js';
import { decode, estimatedTokens, missing, payload, question } from './wire.js';

export { createDecisionSpendBudget, TYPESAFE_ENDPOINT } from './transport.js';
export interface TypeSafeDecisionOptions extends TypeSafeTransportOptions { maxEstimatedTokens?: number; concurrency?: number }

/** Hosted Jev: explicit API billing; identity never spends money on canaries. */
export function createTypeSafeDecision(options: TypeSafeDecisionOptions): DecisionBackend {
  const transport = typeSafeTransport(options);
  const limit = options.maxEstimatedTokens ?? 48_000;
  const concurrency = options.concurrency ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000) throw new Error('Invalid TypeSafe token estimate limit');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid TypeSafe concurrency');
  return {
    capabilities: { billing: 'api', batch: true },
    identity: async signal => transport.identity(signal),
    requestReceipts: transport.receipts,
    async score(requests, signal, receipts) {
      transport.identity(signal);
      const stop = new AbortController();
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
        const response = await transport.send(payload(options.model, batch), estimatedTokens(options.model, batch), signal, receipts);
        const answers = (response.data as { answers?: Record<string, unknown> } | undefined)?.answers;
        for (const request of batch) results.set(request.key, response.reason
          ? missing(request, response.reason, response.failureCause) : decode(request, answers?.[request.key]));
      };
      const sendGroup = async (group: DecisionRequest[]) => {
        let batch: DecisionRequest[] = [];
        for (const request of group) {
          if (batch.length && (batch.length === 64 || estimatedTokens(options.model, [...batch, request]) > limit)) {
            await send(batch); batch = [];
            if (stop.signal.aborted) return;
          }
          batch.push(request);
        }
        await send(batch);
      };
      // Workers share a synchronous iterator; a terminal failure stops admission.
      // Drain started work before rejecting so callers can collect final receipts.
      const pending = groups.values();
      let failure: unknown;
      const worker = async () => {
        while (!stop.signal.aborted) {
          const next = pending.next();
          if (next.done) return;
          try { await sendGroup(next.value); }
          catch (error) {
            if (!stop.signal.aborted) { failure = error; stop.abort(); }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, groups.size) }, worker));
      if (stop.signal.aborted) throw failure;
      return requests.map(request => results.get(request.key)!);
    },
  };
}
