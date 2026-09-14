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

it('binds runtime judge and optimizer identities to the exact trusted execution, including legacy routes', async () => {
  const training = { models: { primary: { provider: 'claude-subscription' as const, model: 'primary' },
    backup: { provider: 'grok-subscription' as const, model: 'backup' } },
    judges: { prose: { model: 'primary', fallbacks: ['backup'] } }, optimizer: { model: 'primary', fallbacks: ['backup'] } };
  const generate = vi.fn(async () => ({ text: 'result', model: 'primary', route: 'accounting-provider', usage: null }));
  const provider = { id: 'accounting-provider', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, temperature: false, seed: false }, generate };
  const make = (inferenceExecutionIdentity?: string, config: typeof training | undefined = training) => createTrainingInference(
    { command: 'train', flags: {}, training: config }, { modelInference: () => provider, inference: () => provider,
      spawnfile: { id: 'execution', version: '1', inferenceExecutionIdentity, createAdapter: vi.fn(), prepareEnvironment: vi.fn() } },
    1000, { prose: 'primary' }, { prose: 0 });
  const host = make(), one = make('image:one'), two = make('image:two');
  expect(one.judges.prose!.identity).toBe(trainingJudgeVersions(training, 'image:one').prose!.version);
  expect(one.judges.prose!.identity).not.toBe(host.judges.prose!.identity);
  expect(one.judges.prose!.identity).not.toBe(two.judges.prose!.identity);
  expect(one.inference.id).not.toBe(host.inference.id);
  expect(one.inference.id).not.toBe(two.inference.id);
  expect(make('image:one').inference.id).toBe(one.inference.id);
  // No training configuration uses the unchanged legacy provider on host, scoped identity in a container.
  const legacy = (identity?: string) => createTrainingInference({ command: 'train', flags: {} }, {
    inference: () => provider, spawnfile: { id: 'execution', version: '1', inferenceExecutionIdentity: identity,
      createAdapter: vi.fn(), prepareEnvironment: vi.fn() } }, 1000, { prose: 'primary' }, { prose: 0 });
  expect(legacy().inference).toBe(provider);
  const scoped = legacy('image:one');
  expect(scoped.judges.prose!.identity).toBe(scoped.inference.id);
  expect(scoped.judges.prose!.identity).toBe(trainingJudgeVersions(undefined, 'image:one', ['prose']).prose!.version);
  expect(trainingJudgeVersions(undefined, undefined, ['prose']).prose!.version).toBe('cli.claude-subscription.v1');
  expect(scoped.inference.id).not.toBe(legacy('image:two').inference.id);
  expect(await scoped.inference.generate({ prompt: 'test', model: 'primary' })).toMatchObject({ route: 'accounting-provider' });
  expect(generate).toHaveBeenCalledOnce();
});
