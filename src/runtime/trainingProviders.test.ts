import { expect, it } from 'vitest';
import { validateTrainingConfiguration } from '../training/index.js';
import { createTrainingProviderRegistry } from './trainingProviders.js';

it('preserves the host-composed local-provider reasoning diagnostic and shape-error precedence', () => {
  const registry = createTrainingProviderRegistry();
  const validate = (model: Record<string, unknown>) => validateTrainingConfiguration({ models: { local: model } }, '$.training', registry);
  const model = { provider: 'ollama', model: 'local', reasoning_effort: 'low' };
  expect(() => validate(model)).toThrow('$.training.models.local.reasoning_effort: only supported for grok-subscription or grok-broker');
  expect(() => validate({ ...model, unknown: true })).toThrow('$.training.models.local.unknown: unknown field');
  expect(() => validate({ ...model, model: '' })).toThrow('$.training.models.local.model: expected a nonempty string');
  expect(validate({ provider: 'ollama', model: 'local', think: true }).models.local).toEqual({ provider: 'ollama', model: 'local', think: true });
});

it('backs every subscription engine id with a booted judge, AGY included', () => {
  const registry = createTrainingProviderRegistry();
  const context = { timeoutMs: 1000, purpose: 'judge' as const, resources: new Map(), onClose: () => undefined };
  for (const id of ['codex-subscription', 'grok-subscription', 'agy-subscription']) {
    const provider = registry.providers[id]!.create({ provider: id, model: 'm' }, context);
    expect(provider).toMatchObject({ id, capabilities: { tools: 'disabled', billing: 'subscription' } });
  }
  expect(validateTrainingConfiguration({ models: { judge: { provider: 'agy-subscription', model: 'default' } } }, '$.training', registry).models.judge)
    .toEqual({ provider: 'agy-subscription', model: 'default' });
});
