import type { InferenceProviderDescriptor, InferenceProviderRegistry } from '../training/contracts/index.js';
import { INFERENCE_POLICY_VERSIONS } from '../training/contracts/index.js';
import { defaultInferenceProviders, DatasetError, InferenceFailure } from '../training/index.js';
import { createBootedJudgeInference } from './daimon/training/booted/index.js';

/** Frozen `grok-broker` catalog: historical YAML and measurement identities keep validating. */
const grokGrantModels = ['grok-4.6', 'grok-4.5', 'grok-build'] as const;
const grokGrantReasoningEfforts = ['low', 'medium', 'high'] as const;
const modelFields = ['provider', 'model', 'endpoint', 'reasoning_effort', 'think', 'keep_alive_seconds', 'max_output_tokens', 'context_window'];
function fail(path: string, message: string): never { throw new DatasetError(path, message); }
function oneOf(value: unknown, choices: readonly unknown[], path: string): void {
  if (!choices.includes(value)) fail(path, `expected one of ${choices.join(', ')}`);
}
function validate(model: Readonly<Record<string, unknown>>, path: string, reasoning: 'none' | 'optional' | 'required'): void {
  for (const field of Object.keys(model)) if (!modelFields.includes(field)) fail(`${path}.${field}`, 'unknown field');
  if (typeof model.model !== 'string' || !model.model.length) fail(`${path}.model`, 'expected a nonempty string');
  if (reasoning === 'required') {
    oneOf(model.model, grokGrantModels, `${path}.model`);
    if (model.reasoning_effort === undefined) fail(`${path}.reasoning_effort`, 'required for grok-broker');
    oneOf(model.reasoning_effort, grokGrantReasoningEfforts, `${path}.reasoning_effort`);
  } else if (model.reasoning_effort !== undefined) {
    if (reasoning === 'none') fail(`${path}.reasoning_effort`, 'only supported for grok-subscription or grok-broker');
    oneOf(model.reasoning_effort, ['low', 'medium', 'high', 'xhigh'], `${path}.reasoning_effort`);
  }
  for (const field of ['think', 'keep_alive_seconds', 'max_output_tokens', 'context_window', 'endpoint']) {
    if (model[field] !== undefined) fail(`${path}.${field}`, 'only supported for ollama');
  }
}

/**
 * Engine-owned descriptors extend the neutral built-ins at host composition.
 * Every subscription engine id names one booted judge engine (`booted/judge.ts`).
 */
export function createTrainingProviderRegistry(): InferenceProviderRegistry {
  const codex: InferenceProviderDescriptor = {
    policyVersion: INFERENCE_POLICY_VERSIONS['codex-subscription']!,
    capabilities: { evaluatorPurposes: ['proposals', 'extraction'], evaluatorBudget: 'requests' },
    validate: (model, path) => validate(model, path, 'none'),
    create: (_model, context) => createBootedJudgeInference({ engine: 'codex', timeoutMs: context.timeoutMs }),
  };
  const grok: InferenceProviderDescriptor = {
    policyVersion: INFERENCE_POLICY_VERSIONS['grok-subscription']!, capabilities: {},
    incompatibleWith: ['grok-broker'], incompatibilityReason: 'grok-broker routes cannot fall back to a desktop grok-subscription login',
    validate: (model, path) => validate(model, path, 'optional'),
    normalizeIdentity: model => ({ ...model, reasoning_effort: model.reasoning_effort ?? 'medium' }),
    create: (model, context) => createBootedJudgeInference({ engine: 'grok', effort: model.reasoning_effort ?? 'medium', timeoutMs: context.timeoutMs }),
  };
  const agy: InferenceProviderDescriptor = {
    policyVersion: INFERENCE_POLICY_VERSIONS['agy-subscription']!, capabilities: {},
    validate: (model, path) => validate(model, path, 'none'),
    create: (_model, context) => createBootedJudgeInference({ engine: 'agy', timeoutMs: context.timeoutMs }),
  };
  // Broker grants lived in the removed training container; the ID still validates, and calls fail closed.
  const broker: InferenceProviderDescriptor = {
    policyVersion: INFERENCE_POLICY_VERSIONS['grok-broker']!,
    capabilities: { purposeScoped: true, brokerAdmission: true }, incompatibleWith: ['grok-subscription'],
    incompatibilityReason: 'grok-broker routes cannot fall back to a desktop grok-subscription login',
    validate: (model, path) => validate(model, path, 'required'),
    create: () => ({ id: 'grok-broker', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
      generate: async () => { throw new InferenceFailure('unavailable', 'grok-broker grants were removed with the training container; use grok-subscription'); } }),
  };
  return { ...defaultInferenceProviders, brokerAdmissionLabel: 'grok-broker',
    // Registration order preserves the historical authored-provider diagnostic.
    providers: { 'claude-subscription': { ...defaultInferenceProviders.providers['claude-subscription']!, validate: (model, path) => validate(model, path, 'none') },
      'codex-subscription': codex, 'grok-subscription': grok, 'grok-broker': broker, 'agy-subscription': agy, ollama: {
      ...defaultInferenceProviders.providers.ollama!,
      validate(model, path) {
        // Preserve the historical host-composed configuration diagnostic outside the neutral core.
        if (model.reasoning_effort !== undefined) {
          // Common authored shape errors precede provider-control diagnostics.
          for (const field of Object.keys(model)) if (!modelFields.includes(field)) fail(`${path}.${field}`, 'unknown field');
          if (typeof model.model !== 'string' || !model.model.length) fail(`${path}.model`, 'expected a nonempty string');
          fail(`${path}.reasoning_effort`, 'only supported for grok-subscription or grok-broker');
        }
        defaultInferenceProviders.providers.ollama!.validate(model, path);
      },
    } } };
}
