import { afterEach, expect, it, vi } from 'vitest';
import '../../../../fixtures/support/training/graderProviders.js';
import { createTrainingInference, providers as registry, validateTrainingConfiguration } from '../../../../fixtures/support/training/providers.js';
import { graderProvider, inferenceProviderDescriptor, type TrainingModel } from '../../../training/contracts/index.js';
import { bindBootedJudges, type BootedJudgeLauncher } from './booted/index.js';

const bindJudge = () => {
  const wake = vi.fn<Awaited<ReturnType<BootedJudgeLauncher['judge']>>['wake']>()
    .mockResolvedValue({ state: 'completed', acceptanceId: 'acceptance', executionId: 'execution', code: null,
      text: 'A synthetic judgment', usage: [], transcript: '{"type":"message"}' });
  const judge = vi.fn<BootedJudgeLauncher['judge']>().mockResolvedValue({ wake });
  bindBootedJudges({ judge });
  return { judge, wake };
};
afterEach(() => bindBootedJudges(undefined));

it.each([
  { provider: 'codex-subscription', engine: 'codex', effort: 'high', expectedEffort: 'high' },
  { provider: 'codex-subscription', engine: 'codex' },
  { provider: 'agy-subscription', engine: 'agy' },
  { provider: 'grok-subscription', engine: 'grok', effort: 'low', expectedEffort: 'low' },
  { provider: 'grok-subscription', engine: 'grok', expectedEffort: 'medium' },
] satisfies Array<{ provider: string; engine: string; effort?: TrainingModel['reasoning_effort']; expectedEffort?: string }>)(
  'routes $provider with effort $effort through the run judge', async ({ provider, engine, effort, expectedEffort }) => {
    const { judge, wake } = bindJudge();
    const model = { provider, model: 'fixture-model', ...(effort === undefined ? {} : { reasoning_effort: effort }) };
    const training = validateTrainingConfiguration({
      models: { configured: model }, optimizer: { model: 'configured', timeout_ms: 500 }
    }, '$.training', registry);
    const client = createTrainingInference({ command: 'train', flags: {}, training }, { inferenceProviders: registry }, 1_000, {}, {});
    try {
      await expect(client.inference.generate({ prompt: 'Judge this fixture.', model: model.model }))
        .resolves.toMatchObject({ route: provider, text: 'A synthetic judgment' });
      expect(judge).toHaveBeenCalledExactlyOnceWith({
        engine, model: model.model, ...(expectedEffort === undefined ? {} : { effort: expectedEffort })
      });
      expect(wake).toHaveBeenCalledExactlyOnceWith('Judge this fixture.', expect.objectContaining({ timeoutMs: 500 }));
    } finally {
      await client.close();
    }
  },
);

it.each([
  { fields: { extra: 'typo' }, diagnostic: '$.model.extra: unknown field' },
  { fields: { model: 42 }, diagnostic: '$.model.model: expected a nonempty string' },
  { fields: { model: '' }, diagnostic: '$.model.model: expected a nonempty string' },
  { fields: { reasoning_effort: 'high' }, diagnostic: '$.model.reasoning_effort: only supported for' },
])('rejects unsupported AGY inference controls $fields', ({ fields, diagnostic }) => {
  const descriptor = inferenceProviderDescriptor(registry, 'agy-subscription');
  expect(() => descriptor.validate({ provider: 'agy-subscription', model: 'fixture-model', ...fields }, '$.model')).toThrow(diagnostic);
});

it('validates and preserves the historical broker ID but refuses calls without waking an engine', async () => {
  const { judge } = bindJudge();
  const model = { provider: 'grok-broker', model: 'grok-build', reasoning_effort: 'high' } as const;
  const descriptor = inferenceProviderDescriptor(registry, model.provider);
  expect(() => descriptor.validate(model, '$.models.broker')).not.toThrow();
  const provider = descriptor.create(model, { purpose: 'judge', timeoutMs: 500, resources: new Map(), onClose() {} });
  expect(provider.id).toBe('grok-broker');
  await expect(provider.generate({ model: model.model, prompt: 'Judge this fixture.' }))
    .rejects.toMatchObject({ kind: 'unavailable', message: expect.stringContaining('grants were removed') });
  expect(judge).not.toHaveBeenCalled();
});

it('opens AGY teachers only without an authored effort', async () => {
  const { judge, wake } = bindJudge();
  const teacher = { id: 'fixture-teacher', provider: 'agy', model: 'fixture-model' };
  const descriptor = graderProvider(teacher.provider);
  expect(() => descriptor.create({ ...teacher, effort: 'high' })).toThrow('AGY teacher effort is unsupported');
  expect(judge).not.toHaveBeenCalled();

  const provider = descriptor.create(teacher, 500);
  await expect(provider.generate({ model: teacher.model, prompt: 'Label this fixture.' }))
    .resolves.toMatchObject({ route: 'agy-subscription', text: 'A synthetic judgment' });
  expect(judge).toHaveBeenCalledExactlyOnceWith({ engine: 'agy', model: teacher.model });
  expect(wake).toHaveBeenCalledExactlyOnceWith('Label this fixture.', expect.objectContaining({ timeoutMs: 500 }));
});
