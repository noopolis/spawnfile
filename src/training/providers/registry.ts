import type { InferenceProviderDescriptor, InferenceProviderRegistry } from '../contracts/inference-registry.js';
import { INFERENCE_POLICY_VERSIONS, LEGACY_DEFAULT_JUDGE_VERSION } from '../../shared/trainingLegacy/index.js';
import { createClaudeInference } from '../inference/claude/index.js';
import { createOllamaInference } from '../inference/ollama/index.js';
import { fail, fields, number, string } from '../cases/index.js';

const baseFields = ['provider', 'model', 'endpoint', 'reasoning_effort', 'think', 'keep_alive_seconds', 'max_output_tokens', 'context_window'];

function base(model: Readonly<Record<string, unknown>>, path: string): void {
  fields(model, baseFields, path);
  string(model.model, `${path}.model`);
  if (model.reasoning_effort !== undefined) fail(`${path}.reasoning_effort`, 'reasoning control is unsupported by this provider');
}
function integer(value: unknown, path: string, min: number, max: number): void {
  if (!Number.isSafeInteger(number(value, path, min, max))) fail(path, 'expected an integer');
}

const subscription: InferenceProviderDescriptor = {
  policyVersion: INFERENCE_POLICY_VERSIONS['claude-subscription']!, legacyJudgeVersion: LEGACY_DEFAULT_JUDGE_VERSION,
  capabilities: {},
  validate(model, path) {
    base(model, path);
    for (const field of baseFields.slice(2)) if (model[field] !== undefined) fail(`${path}.${field}`, 'only supported for ollama');
  },
  create: (_model, context) => createClaudeInference({ timeoutMs: context.timeoutMs }),
};
const local: InferenceProviderDescriptor = {
  policyVersion: INFERENCE_POLICY_VERSIONS.ollama!,
  capabilities: {},
  validate(model, path) {
    base(model, path);
    if (model.think !== undefined && typeof model.think !== 'boolean') fail(`${path}.think`, 'expected a boolean');
    if (model.keep_alive_seconds !== undefined) integer(model.keep_alive_seconds, `${path}.keep_alive_seconds`, 0, 86400);
    if (model.context_window !== undefined) integer(model.context_window, `${path}.context_window`, 512, 1048576);
    if (model.max_output_tokens !== undefined) integer(model.max_output_tokens, `${path}.max_output_tokens`, 1, 131072);
    if (model.endpoint !== undefined) {
      let url: URL;
      try { url = new URL(string(model.endpoint, `${path}.endpoint`)); }
      catch { return fail(`${path}.endpoint`, 'expected an HTTP endpoint'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        fail(`${path}.endpoint`, 'expected HTTP endpoint without credentials, query or fragment');
      }
    }
  },
  create: (model, context) => createOllamaInference({ baseUrl: model.endpoint ?? 'http://127.0.0.1:11434',
    timeoutMs: context.timeoutMs, think: model.think, keepAliveSeconds: model.keep_alive_seconds,
    maxOutputTokens: model.max_output_tokens, contextWindowTokens: model.context_window }),
};

export const defaultInferenceProviders: InferenceProviderRegistry = {
  defaultProviderId: 'claude-subscription',
  evaluatorProviders: { typesafe: { purposes: ['decisions'], budget: 'usd' } },
  providers: { 'claude-subscription': subscription, ollama: local },
};
