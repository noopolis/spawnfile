import type { InferenceResult, Usage } from '../../contracts/execution.js';
import { InferenceFailure } from '../failure.js';

export interface GrokFrames {
  init?: Record<string, unknown>;
  assistant?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export function grokEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(XAI_|GROK_(API_KEY|BASE_URL|AUTH_TOKEN)|OPENAI_API_KEY|ANTHROPIC_API_KEY)/u.test(key)) delete env[key];
  return env;
}

function usageOf(result: Record<string, unknown>): Usage | null {
  const raw = result['usage'] as Record<string, unknown> | undefined;
  const count = (key: string): number | null => typeof raw?.[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : null;
  const input = count('input_tokens'), read = count('cache_read_input_tokens'), write = count('cache_creation_input_tokens');
  const output = count('output_tokens');
  const total = input === null || read === null || write === null ? null : input + read + write;
  if (total === 0 && output === 0) return null;
  return { inputTokens: total !== null && Number.isSafeInteger(total) ? total : null, cachedInputTokens: read,
    cacheWriteInputTokens: write, outputTokens: output, reasoningTokens: null, source: 'grok.result.usage.lower-bound' };
}

export function decodeGrok(frames: GrokFrames, exitCode: number | null): InferenceResult {
  const { init, assistant, result } = frames;
  const usage = result === undefined ? null : usageOf(result);
  const model = typeof init?.['model'] === 'string' && init['model'].trim() ? init['model'] : null;
  const status = result?.['status'] ?? result?.['status_code'] ?? refusalStatus(result);
  if (status === 402 || status === 429 || status === 503 || status === 401 || status === 403) {
    throw new InferenceFailure(status === 402 || status === 429 ? 'quota' : status === 503 ? 'unavailable' : 'authentication',
      'Grok refused inference', { usage, responseModel: model, responseRoute: 'grok-subscription' });
  }
  if (init === undefined) throw new InferenceFailure('protocol', 'Grok omitted initialization');
  if (init['apiKeySource'] !== 'oauth') throw new InferenceFailure('authentication', 'Grok did not acknowledge subscription OAuth');
  if (!Array.isArray(init['tools']) || init['tools'].length !== 0 ||
    (Array.isArray(init['mcp_servers']) && init['mcp_servers'].length !== 0)) throw new InferenceFailure('protocol', 'Grok tool isolation was not acknowledged');
  const message = assistant?.['message'] as Record<string, unknown> | undefined;
  const blocks = message?.['content'];
  const validBlocks = Array.isArray(blocks) && blocks.every((block: unknown) =>
    block !== null && typeof block === 'object' &&
    ((block as Record<string, unknown>)['type'] === 'thinking' ||
      ((block as Record<string, unknown>)['type'] === 'text' && typeof (block as Record<string, unknown>)['text'] === 'string')));
  const text = validBlocks ? blocks.filter((b: Record<string, unknown>) => b['type'] === 'text').map((b: Record<string, unknown>) => b['text']).join('') : ''; 
  if (exitCode !== 0 || result?.['subtype'] !== 'success' || result['is_error'] !== false ||
    !['end_turn', 'stop_sequence'].includes(String(result['stop_reason'])) ||
    (Array.isArray(result['errors']) && result['errors'].length > 0) ||
    !text.trim() || result['result'] !== text || assistant?.['session_id'] !== result['session_id'] ||
    message?.['stop_reason'] !== result['stop_reason'] || model === null ||
    !validBlocks) {
    throw new InferenceFailure('protocol', 'Grok omitted a matching completed response', { usage, responseModel: model });
  }
  return { text, model, modelBasis: 'provider-reported', usage, route: 'grok-subscription' };
}

/** Decode the native error wrapper, never search arbitrary model output for HTTP text. */
function refusalStatus(result: Record<string, unknown> | undefined): unknown {
  if (result?.['is_error'] !== true || !Array.isArray(result['errors']) || result['errors'].length !== 1) return undefined;
  const error: unknown = result['errors'][0];
  if (typeof error !== 'string' || !error.startsWith('Internal error: ')) return undefined;
  try {
    const detail = JSON.parse(error.slice('Internal error: '.length)) as Record<string, unknown>;
    return detail['http_status'];
  } catch { return undefined; }
}
