import { createHash } from 'node:crypto';
import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { decisionHttp, DecisionRequestRejected, type DecisionHttpOptions } from './http.js';
import { DECISION_PROMPT_VERSION, validateDecisionRequest } from './prompt.js';

type JevEnvelope = { model?: unknown; fingerprint?: unknown; system_fingerprint?: unknown; answers?: Record<string, { probabilities?: unknown }> };

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
      // Probe each identity read so server changes invalidate even a retained backend.
      const outcomes: unknown[] = [];
      let rejection: DecisionRequestRejected | undefined;
      let accepted = false;
      for (const request of identityCanaries()) {
        try {
          const response = await send([request], signal);
          const decoded = decodeJev(request, response.answers?.[request.key]?.probabilities);
          if (decoded.status !== 'ok') throw new Error(`Jev identity canary: ${decoded.reason}`);
          accepted = true;
          outcomes.push({ status: 'ok', probabilities: Object.fromEntries(Object.entries(decoded.probabilities!)
            .map(([key, value]) => [key, Math.round(value * 10_000) / 10_000])),
          ...Object.fromEntries(['fingerprint', 'system_fingerprint'].flatMap(key => {
            const value = response[key as 'fingerprint' | 'system_fingerprint'];
            return typeof value === 'string' ? [[key, value]] : [];
          })) });
        } catch (error) {
          if (!(error instanceof DecisionRequestRejected)) throw error;
          rejection = error;
          outcomes.push({ status: '4xx', ...error.fingerprints });
        }
      }
      if (!accepted) throw rejection!;
      const fingerprint = createHash('sha256').update(JSON.stringify({ protocol: DECISION_PROMPT_VERSION,
        model: reportedModel, outcomes })).digest('hex');
      return { backend: 'jev-http', model: reportedModel!, fingerprint };
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
          try {
            const response = await send(batch, signal);
            for (const request of batch) results.set(request.key, decodeJev(request, response.answers?.[request.key]?.probabilities));
          } catch (error) {
            if (!(error instanceof DecisionRequestRejected)) throw error;
            for (const request of batch) results.set(request.key, { key: request.key, status: 'missing', probabilities: null, reason: error.message });
          }
        }
      }
      return requests.map(request => results.get(request.key)!);
    },
  };
}

/** Keep both payloads deterministic; the long state exposes input-size preparation. */
function identityCanaries(): DecisionRequest[] {
  return [
    { key: 'paideia_identity', type: 'yes-no', optionLabels: ['yes', 'no'],
      instructions: 'Is the supplied JSON object empty?', projection: {} },
    { key: 'paideia_identity_long', type: 'yes-no', optionLabels: ['yes', 'no'],
      instructions: 'Does the supplied text end with PAIDEIA_CANARY_END?',
      projection: { text: `${'0123456789 abcdefghijklmnopqrstuvwxyz. '.repeat(1100).slice(0, 39_982)}PAIDEIA_CANARY_END` } },
  ];
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
