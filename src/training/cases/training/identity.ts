import { inferenceProviderDescriptor } from '../../contracts/inference-registry.js';
import type { InferenceProviderRegistry } from '../../contracts/inference-registry.js';
import { defaultInferenceProviders } from '../../providers/index.js';
import { LEGACY_INFERENCE_VERSION_PREFIX, AUTHORED_JUDGE_VERSION_PREFIX } from '../../contracts/index.js';
import { trainingRoutePolicies, trainingInferencePolicies } from '../../providers/index.js';
import { createHash } from 'node:crypto';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { canonical } from '../validation.js';
import { validateTrainingConfiguration } from './schema.js';

/** Register these identities only after constructing the declared runtime judges. */
export function trainingJudgeVersions(configuration?: TrainingConfiguration, executionIdentity?: string, judgeNames: readonly string[] = [], registry: InferenceProviderRegistry = defaultInferenceProviders): Record<string, { version: string }> {
  const defaultDescriptor = inferenceProviderDescriptor(registry, registry.defaultProviderId);
  const legacyVersion = executionIdentity === undefined ? defaultDescriptor.legacyJudgeVersion ?? defaultDescriptor.policyVersion
    : `${LEGACY_INFERENCE_VERSION_PREFIX}${createHash('sha256').update(canonical(trainingInferencePolicies(undefined, executionIdentity, registry))).digest('hex')}`;
  const legacy = Object.fromEntries(judgeNames.map(name => [name, { version: legacyVersion }]));
  if (configuration === undefined) return legacy;
  const config = validateTrainingConfiguration(configuration, '$.training', registry);
  return { ...legacy, ...Object.fromEntries(Object.entries(config.judges ?? {}).map(([name, policy]) => {
    const models = Object.fromEntries([policy.model, ...(policy.fallbacks ?? [])].map(id => {
      const model = config.models[id]!;
      return [id, registry.providers[model.provider]!.normalizeIdentity?.(model) ?? model];
    }));
    const digest = createHash('sha256').update(canonical({ policy, models, providerPolicies: trainingRoutePolicies(config, policy, executionIdentity, registry) })).digest('hex');
    return [name, { version: `${AUTHORED_JUDGE_VERSION_PREFIX}${digest}` }];
  })) };
}
