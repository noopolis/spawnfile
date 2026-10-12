import { afterEach, expect, it, vi } from 'vitest';
import type { TrainingConfiguration, TrainingModel } from '../../contracts/index.js';
import { createTrainingInference } from './inference.js';
import { assertModelRequestAdmission } from '../../inference/index.js';

afterEach(() => vi.unstubAllEnvs());
const broker: TrainingModel = { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' };
const fake = { id: 'fake', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const,
  temperature: false, seed: false }, generate: vi.fn() };

it.each(['claude-subscription', 'grok-subscription', 'ollama'] as const)(
  'rejects capped %s primary and fallback routes before any provider construction', provider => {
    vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
    for (const purpose of ['judge', 'optimizer'] as const) for (const fallback of [false, true]) {
      // Avoid the existing direct-Grok/broker mixing guard masking this admission test.
      const primary = provider === 'grok-subscription' ? { provider: 'claude-subscription' as const, model: 'claude' } : broker;
      const route = fallback ? { model: 'primary', fallbacks: ['outside'] } : { model: 'outside' };
      const training: TrainingConfiguration = { models: { primary, outside: { provider, model: 'outside' } },
        judges: { prose: purpose === 'judge' ? route : { model: 'primary' } },
        optimizer: purpose === 'optimizer' ? route : { model: 'primary' } };
      const modelInference = vi.fn(() => fake);
      expect(() => createTrainingInference({ command: 'train', flags: {}, training }, { modelInference },
        1000, { prose: 'model' }, { prose: 0 })).toThrow(/Capped training requires grok-broker admission/);
      expect(modelInference).not.toHaveBeenCalled();
    }
  });

it('rejects legacy optimizer and judge defaults and unknown cap policies', () => {
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
  const inference = vi.fn(() => fake);
  for (const judges of [{}, { prose: 'model' }] as Record<string, string>[]) {
    expect(() => createTrainingInference({ command: 'train', flags: {} }, { inference },
      1000, judges, { prose: 0 })).toThrow(/legacy default/);
  }
  expect(inference).not.toHaveBeenCalled();
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', '');
  expect(() => assertModelRequestAdmission('grok-broker', 'optimizer')).toThrow(/Unsupported/);
});

it('allows broker-only routes, mechanical comparisons, and uncapped legacy routes', async () => {
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker');
  const modelInference = vi.fn(() => fake);
  const training: TrainingConfiguration = { models: { primary: broker, backup: broker },
    judges: { prose: { model: 'primary', fallbacks: ['backup'] } }, optimizer: { model: 'primary' } };
  const configured = createTrainingInference({ command: 'train', flags: {}, training }, { modelInference },
    1000, { prose: 'model' }, { prose: 0 });
  expect(modelInference).toHaveBeenCalledTimes(3);
  await configured.close();
  const comparison = { candidate: { name: 'fixed', replacements: [{ resource: 'AGENTS.md', source: 'variant.md' }] } };
  expect(() => createTrainingInference({ command: 'train', flags: {}, training: { models: { primary: broker }, comparison } },
    { inference: () => { throw Error('Unexpected optimizer'); } }, 1000, {}, {})).not.toThrow();
  vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', undefined);
  expect(createTrainingInference({ command: 'train', flags: {} }, { inference: () => fake }, 1000, {}, {}).inference).toBe(fake);
});
