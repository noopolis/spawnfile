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
    { provider: 'grok-subscription', policy: 'paideia.grok-attested-response.v3' },
    { provider: 'claude-subscription', policy: 'paideia.claude-attested-response.v3' },
  ]);
  const identities = trainingInferencePolicies(config);
  expect(Object.keys(identities.judges)).toEqual(['a', 'z']);
  expect(identities.optimizer.map(value => value.provider)).toEqual(['claude-subscription', 'grok-subscription']);
  expect(identities.judges.a).toEqual([{ provider: 'ollama', policy: 'paideia.ollama-attested-response.v2' }]);
  identities.optimizer[0]!.policy = 'external mutation';
  expect(trainingInferencePolicies(config).optimizer[0]!.policy).toBe('paideia.claude-attested-response.v3');
});
it('identifies legacy Claude execution without constructing a provider', () => {
  expect(trainingInferencePolicies()).toEqual({ judges: {}, optimizer: [
    { provider: 'claude-subscription', policy: 'paideia.claude-attested-response.v3' },
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

it('versions broker-grant Grok separately from the desktop subscription policy', () => {
  const broker: TrainingConfiguration = { models: { grant: { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' }, desktop: { provider: 'grok-subscription', model: 'grok-4.6' } },
    judges: { j: { model: 'grant' } } };
  expect(trainingRoutePolicies(broker, broker.judges!.j!)).toEqual([{ provider: 'grok-broker', policy: 'paideia.grok-broker-grant-response.v1' }]);
  expect(trainingRoutePolicies(broker, { model: 'desktop' })[0]!.policy).not.toBe('paideia.grok-broker-grant-response.v1');
});
