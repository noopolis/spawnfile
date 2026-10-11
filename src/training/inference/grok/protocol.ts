import { captureInferenceDiagnostic } from '../diagnostic.js';
import type { InferenceResult, Usage } from '../../contracts/execution.js';
import { InferenceFailure, type InferenceFailureEvidence } from '../failure.js';

export interface GrokFrames {
  init?: Record<string, unknown>;
  assistant?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

/**
 * How a Grok CLI authenticates. `subscription` is the saved desktop OAuth login;
 * `broker-grant` reaches a Daimon broker proxy with a short inference grant, so
 * its init reports `apiKeySource: "user"` and the pinned client model id, and the
 * broker-enforced catalog model (the grant's) is the response model.
 */
export type GrokAuthMode =
  | Readonly<{ auth: 'subscription' }>
  | Readonly<{ auth: 'broker-grant'; clientModelId: string; grantModel: string }>;
const SUBSCRIPTION: GrokAuthMode = Object.freeze({ auth: 'subscription' });
export const grokRoute = (mode: GrokAuthMode): string => mode.auth === 'subscription' ? 'grok-subscription' : 'grok-broker-grant';

export function grokEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(XAI_|GROK_(API_KEY|BASE_URL|AUTH_TOKEN)|TYPESAFE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)/u.test(key)) delete env[key];
  return env;
}

function usageOf(result: Record<string, unknown>, mode: GrokAuthMode): Usage | null {
  const raw = result['usage'] as Record<string, unknown> | undefined;
  const count = (key: string): number | null => typeof raw?.[key] === 'number' && Number.isSafeInteger(raw[key]) && raw[key] >= 0 ? raw[key] : null;
  const input = count('input_tokens'), read = count('cache_read_input_tokens'), write = count('cache_creation_input_tokens');
  const output = count('output_tokens');
  const total = input === null || read === null || write === null ? null : input + read + write;
  if (total === 0 && output === 0) return null;
  return { inputTokens: total !== null && Number.isSafeInteger(total) ? total : null, cachedInputTokens: read,
    cacheWriteInputTokens: write, outputTokens: output, reasoningTokens: null, source: mode.auth === 'subscription' ? 'grok.result.usage.lower-bound' : 'grok-broker-grant.result.usage.lower-bound' };
}

export function grokFailureEvidence({ init, result }: GrokFrames, mode: GrokAuthMode = SUBSCRIPTION): InferenceFailureEvidence {
  return { usage: result === undefined ? null : usageOf(result, mode), responseModel: reportedModel(init, mode), responseRoute: grokRoute(mode) };
}

function reportedModel(init: Record<string, unknown> | undefined, mode: GrokAuthMode): string | null {
  const native = typeof init?.['model'] === 'string' && init['model'].trim() ? init['model'] : null;
  if (mode.auth === 'subscription') return native;
  return native === mode.clientModelId ? mode.grantModel : null;
}

/** Validate before generation proceeds; permission denial alone is not tool isolation. */
export function validateGrokInitialization(frames: GrokFrames, mode: GrokAuthMode = SUBSCRIPTION): void {
  const { init } = frames, evidence = grokFailureEvidence(frames, mode);
  if (init === undefined) throw new InferenceFailure('protocol', 'Grok omitted initialization', { ...evidence, diagnostic: captureInferenceDiagnostic('initialization') });
  // Each mode accepts exactly its own source: a grant run reporting OAuth used a desktop login.
  if (init['apiKeySource'] !== (mode.auth === 'subscription' ? 'oauth' : 'user')) {
    throw new InferenceFailure('authentication', mode.auth === 'subscription' ? 'Grok did not acknowledge subscription OAuth' : 'Grok did not acknowledge the broker inference grant', { ...evidence, diagnostic: captureInferenceDiagnostic('subscription') });
  }
  if (mode.auth === 'broker-grant' && init['model'] !== mode.clientModelId) {
    throw new InferenceFailure('authentication', 'Grok did not run the pinned broker inference client model', { ...evidence, diagnostic: captureInferenceDiagnostic('subscription') });
  }
  if (!Array.isArray(init['tools']) || init['tools'].length !== 0 ||
    !Array.isArray(init['mcp_servers']) || init['mcp_servers'].length !== 0) {
    throw new InferenceFailure('protocol', 'Grok tool isolation was not acknowledged', { ...evidence, diagnostic: captureInferenceDiagnostic('tool-isolation') });
  }
}

export function decodeGrok(frames: GrokFrames, exitCode: number | null, mode: GrokAuthMode = SUBSCRIPTION): InferenceResult {
  const { init, assistant, result } = frames;
  const evidence = grokFailureEvidence(frames, mode), usage = evidence.usage ?? null;
  const model = reportedModel(init, mode);
  const status = result?.['status'] ?? result?.['status_code'] ?? refusalStatus(result);
  // The broker's stale shared realm: fail fast, never retry the same authority.
  if (status === AUTH_STALE) throw new InferenceFailure(mode.auth === 'broker-grant' ? 'auth-stale' : 'authentication', 'Grok credential authority is stale', { ...evidence, detail: 'grant-expired' });
  if (status === 402 || status === 429 || status === 503 || status === 401 || status === 403) {
    // The number is the only part of a refusal an operator can act on, so it is
    // retained as a number rather than left for someone to read back out of prose.
    throw new InferenceFailure(status === 402 || status === 429 ? 'quota' : status === 503 ? 'unavailable' : 'authentication',
      'Grok refused inference', { ...evidence, detail: 'provider-status', status });
  }
  validateGrokInitialization(frames, mode);
  const message = assistant?.['message'] as Record<string, unknown> | undefined;
  const blocks = message?.['content'];
  const validBlocks = Array.isArray(blocks) && blocks.every((block: unknown) =>
    block !== null && typeof block === 'object' &&
    ((block as Record<string, unknown>)['type'] === 'thinking' ||
      ((block as Record<string, unknown>)['type'] === 'text' && typeof (block as Record<string, unknown>)['text'] === 'string')));
  const text = validBlocks ? blocks.filter((b: Record<string, unknown>) => b['type'] === 'text').map((b: Record<string, unknown>) => b['text']).join('') : ''; 
  const issue = exitCode !== 0 ? 'native-process'
    : result?.['subtype'] !== 'success' || result['is_error'] !== false || (Array.isArray(result['errors']) && result['errors'].length > 0) ? 'terminal-error'
    : !['end_turn', 'stop_sequence'].includes(String(result['stop_reason'])) ? 'unfinished-response'
    : !validBlocks ? 'content-shape' : !text.trim() ? 'empty-response'
    : result['result'] !== text ? 'response-mismatch'
    : assistant?.['session_id'] !== result['session_id'] ? 'session-mismatch'
    : message?.['stop_reason'] !== result['stop_reason'] ? 'stop-mismatch' : model === null ? 'model-missing' : undefined;
  if (issue) throw new InferenceFailure('protocol', 'Grok omitted a matching completed response', {
    ...evidence, diagnostic: captureInferenceDiagnostic(issue),
  });
  return { text, model: model!, modelBasis: 'provider-reported', usage, route: grokRoute(mode) };
}

const AUTH_STALE = Symbol('auth_stale');
/** Grok 1.0.34 surfaces a broker proxy 401 `{"error":"auth_stale"}` as a JSON string, not an object (live capture). */
const STALE_REALM = /^Unauthorized \(401\) from http:\/\/127\.0\.0\.1:[0-9]{1,5}\/v1\/chat\/completions: auth_stale(?:\n|$)/u;

/** Decode the native error wrapper, never search arbitrary model output for HTTP text. */
function refusalStatus(result: Record<string, unknown> | undefined): unknown {
  if (result?.['is_error'] !== true || !Array.isArray(result['errors']) || result['errors'].length !== 1) return undefined;
  const error: unknown = result['errors'][0];
  if (typeof error !== 'string' || !error.startsWith('Internal error: ')) return undefined;
  try {
    const detail: unknown = JSON.parse(error.slice('Internal error: '.length));
    if (typeof detail === 'string') return STALE_REALM.test(detail) ? AUTH_STALE : /^Unauthorized \(401\) /u.test(detail) ? 401 : undefined;
    return detail !== null && typeof detail === 'object' ? (detail as Record<string, unknown>)['http_status'] : undefined;
  } catch { return undefined; }
}
