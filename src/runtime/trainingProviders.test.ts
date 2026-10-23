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
