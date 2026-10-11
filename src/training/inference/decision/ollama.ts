import type { DecisionBackend, DecisionRequest, DecisionResult } from '../../contracts/grading.js';
import { decisionHttp, DecisionRequestRejected, type DecisionHttpOptions } from './http.js';
import { DECISION_LETTERS, decisionPrompt, validateDecisionRequest } from './prompt.js';

export interface OllamaDecisionOptions extends DecisionHttpOptions { model: string }

export function createOllamaDecision(options: OllamaDecisionOptions): DecisionBackend {
  const http = decisionHttp(options);
  if (!options.model.trim() || options.model.startsWith('-')) throw new Error('Invalid decision model');
  const url = (resource: string) => new URL(`${http.endpoint.pathname.replace(/\/$/u, '')}/api/${resource}`, http.endpoint).href;
  let pinnedDigest: string | undefined;
  async function identity(signal?: AbortSignal) {
    const data = await http.json(url('tags'), undefined, signal) as { models?: { name?: string; digest?: string }[] } | null;
    const installed = data?.models?.find(model => model.name === options.model);
    if (typeof installed?.digest !== 'string' || !installed.digest.trim()) throw new Error(`Decision model ${options.model} is not installed with a digest; never pull automatically`);
    if (pinnedDigest !== undefined && pinnedDigest !== installed.digest) throw new Error('Ollama model digest changed');
    pinnedDigest = installed.digest;
    return { backend: 'ollama-logprobs', model: options.model, digest: installed.digest };
  }
  return {
    identity,
    async score(requests, signal) {
      if (!requests.length) return [];
      // Refuse missing models before /api/chat (which must never trigger provisioning).
      await identity(signal);
      const results: DecisionResult[] = [];
      for (const request of requests) {
        validateDecisionRequest(request);
        try {
          const data = await http.json(url('chat'), { model: options.model, stream: false, think: false,
            logprobs: true, top_logprobs: 20,
            messages: [...(request.system === undefined ? [] : [{ role: 'system', content: request.system }]),
              { role: 'user', content: decisionPrompt(request) }], options: { temperature: 0, num_predict: 1 } }, signal);
          results.push(decodeLogprobs(request, data));
        } catch (error) {
          if (!(error instanceof DecisionRequestRejected)) throw error;
          results.push(missing(request, error.message));
        }
      }
      return results;
    },
  };
}

const missing = (request: DecisionRequest, reason: string): DecisionResult => ({ key: request.key, status: 'missing', probabilities: null, reason });

/** Native Ollama /api/chat returns logprobs as an array of token records. */
export function decodeLogprobs(request: DecisionRequest, raw: unknown): DecisionResult {
  const data = raw as { done?: boolean; message?: { content?: string; thinking?: string }; logprobs?: unknown } | null;
  if (data?.done !== true || data.message?.thinking) return missing(request, 'Incomplete response or unexpected thinking');
  const first = Array.isArray(data.logprobs) ? data.logprobs[0] as { token?: string; top_logprobs?: unknown } | undefined : undefined;
  const letters = [...DECISION_LETTERS.slice(0, request.optionLabels.length)];
  if (typeof first?.token !== 'string' || !letters.some(letter => first.token === letter || first.token === ` ${letter}`)) {
    return missing(request, 'Generated token is not an option letter');
  }
  const candidates = first.top_logprobs;
  if (!Array.isArray(candidates) || !candidates.length) return missing(request, 'Missing top logprobs');
  const tokenMass = new Map<string, number>();
  for (const candidate of candidates as { token?: unknown; logprob?: unknown }[]) {
    if (typeof candidate?.token !== 'string' || typeof candidate.logprob !== 'number' || !Number.isFinite(candidate.logprob) || candidate.logprob > 0 || tokenMass.has(candidate.token)) {
      return missing(request, 'Invalid top logprobs');
    }
    tokenMass.set(candidate.token, Math.exp(candidate.logprob));
  }
  const mass = letters.map(letter => (tokenMass.get(letter) ?? 0) + (tokenMass.get(` ${letter}`) ?? 0));
  if (mass.reduce((sum, p) => sum + p, 0) < 0.5) return missing(request, 'Option mass below 0.5');
  const omitted = letters.map(letter => Number(!tokenMass.has(letter)) + Number(!tokenMass.has(` ${letter}`)));
  const omittedCount = omitted.reduce((sum, count) => sum + count, 0);
  if (omittedCount) {
    const pMin = Math.min(...tokenMass.values());
    if (pMin * omittedCount > 0.01) return missing(request, 'Omitted token variant bound exceeds 0.01');
    if (!request.expectedOptions?.length) return missing(request, 'Expected options required for conservative bound');
    for (const [i, count] of omitted.entries()) {
      if (!request.expectedOptions.includes(request.optionLabels[i]!)) mass[i]! += count * pMin;
    }
  }
  const total = mass.reduce((sum, p) => sum + p, 0);
  return { key: request.key, status: 'ok', probabilities: Object.fromEntries(request.optionLabels.map((label, i) => [String(label), mass[i]! / total])),
    bounded: omittedCount > 0 };
}
