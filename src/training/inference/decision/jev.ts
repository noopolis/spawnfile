import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { decisionHttp, type DecisionHttpOptions } from './http.js';
import { validateDecisionRequest } from './prompt.js';

type JevEnvelope = { model?: unknown; answers?: Record<string, { probabilities?: unknown }> };

/** Operator endpoint owns model loading and temperature=1; transport never calibrates. */
export function createJevDecision(options: DecisionHttpOptions): DecisionBackend {
  const http = decisionHttp(options);
  let reportedModel: string | undefined;
  async function send(requests: DecisionRequest[], signal?: AbortSignal): Promise<JevEnvelope> {
    const questions = Object.fromEntries(requests.map(request => {
      const criteria = request.type === 'score' ? request.optionLabels.map(option => `Score ${option}`)
        : Object.fromEntries(request.optionLabels.map(option => [wireOption(request, option), String(option)]));
      return [request.key, { type: request.type === 'yes-no' ? 'noul' : request.type,
        instructions: [request.system, request.instructions].filter(Boolean).join('\n'), criteria }];
    }));
    const raw = await http.json(http.endpoint.href, { state: JSON.stringify(requests[0]!.projection), questions }, signal) as JevEnvelope | null;
    if (typeof raw?.model !== 'string' || !raw.model.trim()) throw new Error('Jev omitted reported model');
    if (reportedModel !== undefined && reportedModel !== raw.model) throw new Error('Jev reported model changed');
    reportedModel = raw.model;
    return raw;
  }
  return {
    async identity(signal) {
      signal?.throwIfAborted();
      // Jev has no required metadata endpoint; a fixed probe pins response identity.
      if (reportedModel === undefined) await send([{ key: 'paideia_identity', type: 'yes-no', optionLabels: ['yes', 'no'],
        instructions: 'Is the supplied JSON object empty?', projection: {} }], signal);
      return { backend: 'jev-http', model: reportedModel! };
    },
    async score(requests, signal) {
      requests.forEach(validateDecisionRequest);
      // A shared Jev state must not disclose another question's projection.
      const groups = new Map<string, DecisionRequest[]>();
      for (const request of requests) {
        const key = JSON.stringify(request.projection);
        const group = groups.get(key) ?? [];
        group.push(request); groups.set(key, group);
      }
      const results = new Map<string, DecisionResult>();
      for (const group of groups.values()) {
        for (let start = 0; start < group.length; start += 16) {
          const batch = group.slice(start, start + 16);
          const response = await send(batch, signal);
          for (const request of batch) results.set(request.key, decodeJev(request, response.answers?.[request.key]?.probabilities));
        }
      }
      return requests.map(request => results.get(request.key)!);
    },
  };
}

function wireOption(request: DecisionRequest, option: string | number): string {
  return request.type === 'yes-no' ? String(option === 'yes')
    : request.type === 'score' ? String(request.optionLabels.indexOf(option)) : String(option);
}

function decodeJev(request: DecisionRequest, raw: unknown): DecisionResult {
  const probabilities: Record<string, number> = {};
  if (raw !== null && typeof raw === 'object') {
    const values = raw as Record<string, unknown>;
    const yesNoKeys = request.type === 'yes-no' && !('true' in values || 'false' in values);
    for (const option of request.optionLabels) {
      const p = values[yesNoKeys ? String(option) : wireOption(request, option)];
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) break;
      probabilities[String(option)] = p;
    }
  }
  if (Object.keys(probabilities).length !== request.optionLabels.length || Math.abs(Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1) > 1e-5) {
    return { key: request.key, status: 'missing', probabilities: null, reason: 'Jev requires probabilities over every option summing to one' };
  }
  return { key: request.key, status: 'ok', probabilities };
}
