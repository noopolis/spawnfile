import { trainingRoutePolicies, trainingInferencePolicies } from '../../contracts/inference-policy.js';
import { createHash } from 'node:crypto';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { canonical } from '../validation.js';
import { validateTrainingConfiguration } from './schema.js';

/** Register these identities only after constructing the declared runtime judges. */
export function trainingJudgeVersions(configuration?: TrainingConfiguration, executionIdentity?: string, judgeNames: readonly string[] = []): Record<string, { version: string }> {
  const legacyVersion = executionIdentity === undefined ? 'cli.claude-subscription.v1'
    : `paideia.legacy-inference:${createHash('sha256').update(canonical(trainingInferencePolicies(undefined, executionIdentity))).digest('hex')}`;
  const legacy = Object.fromEntries(judgeNames.map(name => [name, { version: legacyVersion }]));
  if (configuration === undefined) return legacy;
  const config = validateTrainingConfiguration(configuration);
  return { ...legacy, ...Object.fromEntries(Object.entries(config.judges ?? {}).map(([name, policy]) => {
    const models = Object.fromEntries([policy.model, ...(policy.fallbacks ?? [])].map(id => {
      const model = config.models[id]!;
      return [id, model.provider === 'grok-subscription' ? { ...model, reasoning_effort: model.reasoning_effort ?? 'medium' } : model];
    }));
    const digest = createHash('sha256').update(canonical({ policy, models, providerPolicies: trainingRoutePolicies(config, policy, executionIdentity) })).digest('hex');
    return [name, { version: `paideia.authored-judge.v1:sha256:${digest}` }];
  })) };
}
