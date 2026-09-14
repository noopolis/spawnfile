import { expect, it } from 'vitest';
import { trainingInferencePolicies, trainingRoutePolicies } from './inference-policy.js';
import type { TrainingConfiguration } from './training-config.js';

const config: TrainingConfiguration = {
  models: { primary: { provider: 'grok-subscription', model: 'grok' },
    fallback: { provider: 'claude-subscription', model: 'claude' }, local: { provider: 'ollama', model: 'local' } },
  judges: { z: { model: 'primary', fallbacks: ['fallback'] }, a: { model: 'local' } },
  optimizer: { model: 'fallback', fallbacks: ['primary'] },
};
it('returns maintained policy versions in declared route order without model or host data', () => {
  expect(trainingRoutePolicies(config, config.judges!.z!)).toEqual([
    { provider: 'grok-subscription', policy: 'paideia.grok-no-plan-schema.v2' },
    { provider: 'claude-subscription', policy: 'paideia.claude-inference.v1' },
  ]);
  const identities = trainingInferencePolicies(config);
  expect(Object.keys(identities.judges)).toEqual(['a', 'z']);
  expect(identities.optimizer.map(value => value.provider)).toEqual(['claude-subscription', 'grok-subscription']);
  expect(identities.judges.a).toEqual([{ provider: 'ollama', policy: 'paideia.ollama-inference.v1' }]);
  identities.optimizer[0]!.policy = 'external mutation';
  expect(trainingInferencePolicies(config).optimizer[0]!.policy).toBe('paideia.claude-inference.v1');
});
it('identifies legacy Claude execution without constructing a provider', () => {
  expect(trainingInferencePolicies()).toEqual({ judges: {}, optimizer: [
    { provider: 'claude-subscription', policy: 'paideia.claude-inference.v1' },
  ] });
  expect(trainingInferencePolicies({ models: config.models })).toEqual(trainingInferencePolicies());
});

it('binds explicit execution to every primary, fallback and legacy policy without changing host defaults', () => {
  const scoped = trainingInferencePolicies(config, 'image:sha256:one');
  for (const route of [...Object.values(scoped.judges), scoped.optimizer]) {
    expect(route.every(entry => entry.executionIdentity === 'image:sha256:one')).toBe(true);
  }
  expect(trainingInferencePolicies(undefined, 'image:sha256:one').optimizer[0]!.executionIdentity).toBe('image:sha256:one');
  expect(trainingInferencePolicies(config, 'image:sha256:two')).not.toEqual(scoped);
  for (const invalid of ['', ' ', 'bad\nidentity', 'x'.repeat(1025), 12]) {
    expect(() => trainingInferencePolicies(config, invalid as string)).toThrow('Inference execution identity');
  }
});
