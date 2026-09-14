import type { InferenceProvider } from '../../contracts/execution.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceSchema, validateInferenceResponse } from '../response-schema.js';

export interface OllamaInferenceOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Native Ollama chat, without tools. Reasoning is never substituted for final content. */
export function createOllamaInference(options: OllamaInferenceOptions): InferenceProvider {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid Ollama endpoint');
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid Ollama timeout');
  const endpoint = new URL(`${base.pathname.replace(/\/$/u, '')}/api/chat`, base).href;
  return {
    id: `ollama:${base.href}`,
    capabilities: { tools: 'disabled', billing: 'local', temperature: true, seed: true },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      const responseSchema = request.responseSchema === undefined ? undefined : structuredClone(request.responseSchema);
      if (responseSchema !== undefined && (base.hostname === 'ollama.com' || base.hostname.endsWith('.ollama.com') || request.model.endsWith('-cloud'))) {
        throw new InferenceFailure('unsupported', 'Ollama Cloud does not support structured output');
      }
      if (!request.prompt.trim() || !request.model.trim() || request.model.startsWith('-') ||
        (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0)) ||
        (request.seed !== undefined && !Number.isSafeInteger(request.seed))) throw new InferenceFailure('unsupported', 'Invalid Ollama request');
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Ollama cancelled');
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      let response: Response;
      try {
        response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: request.model, stream: false,
            ...(responseSchema === undefined ? {} : { format: responseSchema }),
            messages: [...(request.system === undefined ? [] : [{ role: 'system', content: request.system }]),
              { role: 'user', content: request.prompt }],
            options: { temperature: request.temperature, seed: request.seed } }),
        });
      } catch {
        throw new InferenceFailure(request.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'transport', 'Ollama request failed');
      }
      if (!response.ok) throw new InferenceFailure(response.status === 429 ? 'quota' :
        response.status === 401 || response.status === 403 ? 'authentication' :
          response.status >= 500 || response.status === 404 ? 'unavailable' :
            responseSchema !== undefined && response.status === 400 ? 'unsupported' : 'protocol', `Ollama HTTP ${response.status}`);
      let raw: unknown;
      try { raw = await response.json(); } catch {
        throw new InferenceFailure(request.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'protocol', 'Ollama response body failed');
      }
      const data = raw as Record<string, unknown> | null;
      const message = data?.['message'] as Record<string, unknown> | undefined;
      const count = (key: string): number | null => typeof data?.[key] === 'number' && Number.isSafeInteger(data[key]) && data[key] >= 0 ? data[key] : null;
      const evidence = {
        responseModel: typeof data?.['model'] === 'string' && data['model'].trim() ? data['model'] : null,
        responseRoute: `ollama:${base.href}`,
        usage: { inputTokens: count('prompt_eval_count'), outputTokens: count('eval_count'), cachedInputTokens: null,
          reasoningTokens: null, source: 'ollama.chat.counts' },
      };
      if ((data?.['done_reason'] !== undefined && data['done_reason'] !== 'stop') || data?.['done'] !== true || typeof data['model'] !== 'string' || !data['model'].trim() ||
        typeof message?.['content'] !== 'string' || !message['content'].trim() ||
        (Array.isArray(message['tool_calls']) && message['tool_calls'].length > 0)) throw new InferenceFailure('protocol', 'Ollama omitted a completed text response', evidence);
      try { validateInferenceResponse(message['content'], responseSchema); }
      catch { throw new InferenceFailure('protocol', 'Ollama response violated the requested schema', evidence); }
      return { text: message['content'], model: data['model'], modelBasis: 'provider-reported', route: `ollama:${base.href}`,
        usage: evidence.usage };
    },
  };
}
