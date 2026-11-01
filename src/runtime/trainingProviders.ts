import type { InferenceProviderDescriptor, InferenceProviderRegistry } from '../training/contracts/index.js';
import { INFERENCE_POLICY_VERSIONS } from '../training/contracts/index.js';
import { defaultInferenceProviders, DatasetError } from '../training/index.js';
import { createCodexInference } from './daimon/training/providers/codex-subscription/index.js';
import { createGrokInference } from './daimon/training/providers/grok-subscription/index.js';

const modelFields = ['provider', 'model', 'endpoint', 'reasoning_effort', 'think', 'keep_alive_seconds', 'max_output_tokens', 'context_window'];
function fail(path: string, message: string): never { throw new DatasetError(path, message); }
function oneOf(value: unknown, choices: readonly unknown[], path: string): void {
  if (!choices.includes(value)) fail(path, `expected one of ${choices.join(', ')}`);
}
function validate(model: Readonly<Record<string, unknown>>, path: string, reasoning: 'none' | 'optional'): void {
  for (const field of Object.keys(model)) if (!modelFields.includes(field)) fail(`${path}.${field}`, 'unknown field');
  if (typeof model.model !== 'string' || !model.model.length) fail(`${path}.model`, 'expected a nonempty string');
  if (model.reasoning_effort !== undefined) {
    if (reasoning === 'none') fail(`${path}.reasoning_effort`, 'only supported for grok-subscription');
    oneOf(model.reasoning_effort, ['low', 'medium', 'high', 'xhigh'], `${path}.reasoning_effort`);
  }
  for (const field of ['think', 'keep_alive_seconds', 'max_output_tokens', 'context_window', 'endpoint']) {
    if (model[field] !== undefined) fail(`${path}.${field}`, 'only supported for ollama');
  }
}

/** Engine-owned descriptors extend the neutral built-ins at host composition. */
export function createTrainingProviderRegistry(): InferenceProviderRegistry {
  const codex: InferenceProviderDescriptor = {
    policyVersion: INFERENCE_POLICY_VERSIONS['codex-subscription']!,
    capabilities: { evaluatorPurposes: ['proposals', 'extraction'], evaluatorBudget: 'requests' },
    validate: (model, path) => validate(model, path, 'none'),
    create: (_model, context) => createCodexInference({ timeoutMs: context.timeoutMs }),
  };
  const grok: InferenceProviderDescriptor = {
    policyVersion: INFERENCE_POLICY_VERSIONS['grok-subscription']!, capabilities: {},
    validate: (model, path) => validate(model, path, 'optional'),
    normalizeIdentity: model => ({ ...model, reasoning_effort: model.reasoning_effort ?? 'medium' }),
    create: (model, context) => createGrokInference({ timeoutMs: context.timeoutMs, reasoningEffort: model.reasoning_effort }),
  };
  return { ...defaultInferenceProviders,
    // Registration order preserves the historical authored-provider diagnostic.
    providers: { 'claude-subscription': { ...defaultInferenceProviders.providers['claude-subscription']!, validate: (model, path) => validate(model, path, 'none') },
      'codex-subscription': codex, 'grok-subscription': grok, ollama: {
      ...defaultInferenceProviders.providers.ollama!,
      validate(model, path) {
        // Preserve the historical host-composed configuration diagnostic outside the neutral core.
        if (model.reasoning_effort !== undefined) {
          // Common authored shape errors precede provider-control diagnostics.
          for (const field of Object.keys(model)) if (!modelFields.includes(field)) fail(`${path}.${field}`, 'unknown field');
          if (typeof model.model !== 'string' || !model.model.length) fail(`${path}.model`, 'expected a nonempty string');
          fail(`${path}.reasoning_effort`, 'only supported for grok-subscription');
        }
        defaultInferenceProviders.providers.ollama!.validate(model, path);
      },
    } } };
}
