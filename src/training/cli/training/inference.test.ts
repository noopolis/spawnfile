import { expect, it, vi } from 'vitest';
import { createGrokInference } from '../../inference/index.js';
import { parseDatasetYaml, trainingJudgeVersions } from '../../cases/index.js';
import { createTrainingInference } from './inference.js';

vi.mock('../../inference/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../inference/index.js')>();
  return { ...actual, createGrokInference: vi.fn(actual.createGrokInference) };
});

it('passes independent YAML judge and optimizer efforts to the actual provider factory', () => {
  const dataset = parseDatasetYaml(`
schema: paideia.dataset.v1
id: efforts
checks:
  - { id: check, eval: contains-any, input: output.text, values: [done] }
records:
  - { id: one, input: { prompt: Write. } }
training:
  models:
    quick: { provider: grok-subscription, model: grok-4.6, reasoning_effort: low }
    compiler: { provider: grok-subscription, model: grok-4.6, reasoning_effort: medium }
  judges:
    prose: { model: quick }
  optimizer: { model: compiler }
`).dataset;
  vi.mocked(createGrokInference).mockClear();
  createTrainingInference({ command: 'train', flags: {}, training: dataset.training }, {}, 240000, { prose: 'grok-4.6' }, { prose: 0 });
  expect(createGrokInference).toHaveBeenNthCalledWith(1, { timeoutMs: 240000, reasoningEffort: 'low' });
  expect(createGrokInference).toHaveBeenNthCalledWith(2, { timeoutMs: 240000, reasoningEffort: 'medium' });
  const baseline = trainingJudgeVersions(dataset.training!);
  const changed = structuredClone(dataset.training!);
  changed.models.quick!.reasoning_effort = 'high';
  expect(trainingJudgeVersions(changed)).not.toEqual(baseline);
  delete changed.models.quick!.reasoning_effort;
  const implicit = trainingJudgeVersions(changed);
  changed.models.quick!.reasoning_effort = 'medium';
  expect(trainingJudgeVersions(changed)).toEqual(implicit);
});

it('honors YAML timeout fallbacks through the training factory without a hidden attempt override', async () => {
  vi.useFakeTimers();
  try {
    const dataset = parseDatasetYaml(`
schema: paideia.dataset.v1
id: timeout-fallback
checks:
  - { id: check, eval: contains-any, input: output.text, values: [done] }
records:
  - { id: one, input: { prompt: Write. } }
training:
  models:
    reflection: { provider: grok-subscription, model: grok-4.6, reasoning_effort: medium }
    backup: { provider: claude-subscription, model: claude-sonnet-4-6 }
  optimizer: { model: reflection, fallbacks: [backup], attempts: 2, timeout_ms: 180000 }
`).dataset;
    const calls: string[] = [];
    const { inference } = createTrainingInference({ command: 'train', flags: {}, training: dataset.training }, {
      modelInference(model) { return { id: model.provider,
        capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
        async generate(request) {
          calls.push(request.model);
          if (model.provider === 'grok-subscription') return new Promise(() => undefined);
          return { text: 'compiled', model: model.model, route: model.provider, usage: null };
        } }; },
    }, 240000, {}, {});
    const result = inference.generate({ prompt: 'compile', model: 'ignored' });
    await vi.advanceTimersByTimeAsync(90000);
    expect((await result).text).toBe('compiled');
    expect(calls).toEqual(['grok-4.6', 'claude-sonnet-4-6']);
  } finally { vi.useRealTimers(); }
});
