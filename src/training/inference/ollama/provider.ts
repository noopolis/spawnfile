import type { InferenceProvider } from '../../contracts/execution.js';
import { ollamaContextSupport } from './context.js';
import { InferenceFailure } from '../failure.js';
import { validateInferenceSchema, validateInferenceResponse } from '../response-schema.js';

export interface OllamaInferenceOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  think?: boolean;
  keepAliveSeconds?: number;
  maxOutputTokens?: number;
  contextWindowTokens?: number;
}

/** Native Ollama chat, without tools. Reasoning is never substituted for final content. */
export function createOllamaInference(options: OllamaInferenceOptions): InferenceProvider {
  const base = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid Ollama endpoint');
  const timeoutMs = options.timeoutMs ?? 180_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('Invalid Ollama timeout');
  const { think, keepAliveSeconds, maxOutputTokens, contextWindowTokens } = options;
  if ((contextWindowTokens !== undefined && (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 512 || contextWindowTokens > 1048576)) ||
    (think !== undefined && typeof think !== 'boolean') ||
    (keepAliveSeconds !== undefined && (!Number.isSafeInteger(keepAliveSeconds) || keepAliveSeconds < 0 || keepAliveSeconds > 86400)) ||
    (maxOutputTokens !== undefined && (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 131072))) {
    throw new InferenceFailure('unsupported', 'Invalid native Ollama completion controls');
  }
  const endpoint = new URL(`${base.pathname.replace(/\/$/u, '')}/api/chat`, base).href;
  const verifyContext = ollamaContextSupport(base, options.fetch ?? fetch);
  return {
    id: `ollama:${base.href}`,
    capabilities: { tools: 'disabled', billing: 'local', temperature: true, seed: true },
    async generate(request) {
      validateInferenceSchema(request.responseSchema);
      const responseSchema = request.responseSchema === undefined ? undefined : structuredClone(request.responseSchema);
      if ((responseSchema !== undefined || contextWindowTokens !== undefined || think !== undefined || keepAliveSeconds !== undefined || maxOutputTokens !== undefined) && (base.hostname === 'ollama.com' || base.hostname.endsWith('.ollama.com') || request.model.endsWith('-cloud'))) {
        throw new InferenceFailure('unsupported', 'Ollama Cloud does not support the requested native controls');
      }
      if (think !== undefined && /(?:^|\/)gpt-oss(?::|$)/u.test(request.model)) throw new InferenceFailure('unsupported', 'GPT-OSS requires thinking levels; boolean think is unsupported');
      if (!request.prompt.trim() || !request.model.trim() || request.model.startsWith('-') ||
        (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0)) ||
        (request.seed !== undefined && !Number.isSafeInteger(request.seed))) throw new InferenceFailure('unsupported', 'Invalid Ollama request');
      if (request.signal?.aborted) throw new InferenceFailure('cancelled', 'Ollama cancelled');
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
      let response: Response;
      try {
        if (contextWindowTokens !== undefined) await verifyContext(signal);
        response = await (options.fetch ?? fetch)(endpoint, { method: 'POST', signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: request.model, stream: false,
            ...(contextWindowTokens === undefined ? {} : { truncate: false, shift: false }),
            ...(think === undefined ? {} : { think }),
            ...(keepAliveSeconds === undefined ? {} : { keep_alive: `${keepAliveSeconds}s` }),
            ...(responseSchema === undefined ? {} : { format: responseSchema }),
            messages: [...(request.system === undefined ? [] : [{ role: 'system', content: request.system }]),
              { role: 'user', content: request.prompt }],
            options: { ...(contextWindowTokens === undefined ? {} : { num_ctx: contextWindowTokens }), temperature: request.temperature, seed: request.seed, ...(maxOutputTokens === undefined ? {} : { num_predict: maxOutputTokens }) } }),
        });
      } catch (error) {
        if (error instanceof InferenceFailure) throw error;
        throw new InferenceFailure(request.signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : 'transport', 'Ollama request failed');
      }
      if (!response.ok) throw new InferenceFailure(response.status === 429 ? 'quota' :
        response.status === 401 || response.status === 403 ? 'authentication' :
          response.status >= 500 || response.status === 404 ? 'unavailable' :
            (responseSchema !== undefined || think !== undefined || keepAliveSeconds !== undefined || maxOutputTokens !== undefined || contextWindowTokens !== undefined) && response.status === 400 ? 'unsupported' : 'protocol', `Ollama HTTP ${response.status}`);
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
      if (think === false && typeof message['thinking'] === 'string' && message['thinking'].length) throw new InferenceFailure('unsupported', 'Ollama returned thinking despite think:false', evidence);
      try { validateInferenceResponse(message['content'], responseSchema); }
      catch { throw new InferenceFailure('protocol', 'Ollama response violated the requested schema', evidence); }
      return { text: message['content'], model: data['model'], modelBasis: 'provider-reported', route: `ollama:${base.href}`,
        usage: evidence.usage };
    },
  };
}
