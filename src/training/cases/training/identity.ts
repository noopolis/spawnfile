import { createHash } from 'node:crypto';
import type { TrainingConfiguration } from '../../contracts/training-config.js';
import { canonical } from '../validation.js';
import { validateTrainingConfiguration } from './schema.js';

/** Register these identities only after constructing the declared runtime judges. */
export function trainingJudgeVersions(configuration: TrainingConfiguration): Record<string, { version: string }> {
  const config = validateTrainingConfiguration(configuration);
  return Object.fromEntries(Object.entries(config.judges ?? {}).map(([name, policy]) => {
    const models = Object.fromEntries([policy.model, ...(policy.fallbacks ?? [])].map(id => {
      const model = config.models[id]!;
      return [id, model.provider === 'grok-subscription' ? { ...model, reasoning_effort: model.reasoning_effort ?? 'medium' } : model];
    }));
    const digest = createHash('sha256').update(canonical({ policy, models })).digest('hex');
    return [name, { version: `paideia.authored-judge.v1:sha256:${digest}` }];
  }));
}
