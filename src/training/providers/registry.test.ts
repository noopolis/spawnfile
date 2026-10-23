import { expect, it, vi } from 'vitest';
import type { InferenceProviderDescriptor, InferenceProviderRegistry } from '../contracts/index.js';
import { inferenceProviderDescriptor } from '../contracts/index.js';
import { trainingInferencePolicies } from './index.js';
import { parseDatasetYaml, resolveDataset, trainingJudgeVersions, validateTrainingConfiguration } from '../cases/index.js';
import { createTrainingInference, configuredCostRoutes } from '../cli/training/index.js';
import { defaultInferenceProviders } from './index.js';

const provider = { id: 'registered', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const, temperature: false, seed: false },
  generate: vi.fn(async () => ({ text: 'done', model: 'registered-model', route: 'registered', usage: null })) };
function registration() {
  const close = vi.fn(async () => undefined);
  const create = vi.fn<InferenceProviderDescriptor['create']>((_model, context) => {
    if (!context.resources.has('shared')) { context.resources.set('shared', true); context.onClose(close); }
    return provider;
  });
  const validate = vi.fn<InferenceProviderDescriptor['validate']>((model, path) => {
    if (model.model !== 'registered-model') throw new Error(`${path}.model: registration rejected model`);
  });
  const descriptor: InferenceProviderDescriptor = { policyVersion: 'registered-policy', legacyJudgeVersion: 'registered-legacy',
    capabilities: { purposeScoped: true }, validate, create,
    normalizeIdentity: model => ({ ...model, reasoning_effort: model.reasoning_effort ?? 'high' }) };
  const registry: InferenceProviderRegistry = { defaultProviderId: 'registered', providers: { registered: descriptor } };
  return { registry, create, validate, close };
}
const config = { models: { local: { provider: 'registered', model: 'registered-model' } },
  judges: { prose: { model: 'local' } }, optimizer: { model: 'local' } };

it('uses an externally registered validator, identity default, policy and factory throughout the core', async () => {
  const { registry, create, validate, close } = registration();
  expect(() => validateTrainingConfiguration(config)).toThrow(expect.objectContaining({ message: '$.training.models.local.provider: expected one of claude-subscription, ollama' }));
  const parsed = parseDatasetYaml(`schema: spawnfile.training.dataset.v1
id: registry
training: ${JSON.stringify(config)}
checks: [{id: done, eval: contains-any, input: output.text, values: [done]}]
records: [{id: one, input: {prompt: Write.}}]
`, { inferenceProviders: registry });
  expect(resolveDataset(parsed, { inferenceProviders: registry }).training).toEqual(config);
  expect(validate).toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  const identity = trainingJudgeVersions(config, undefined, [], registry);
  const explicit = structuredClone(config) as Parameters<typeof trainingJudgeVersions>[0];
  explicit!.models.local!.reasoning_effort = 'high';
  expect(trainingJudgeVersions(explicit, undefined, [], registry)).toEqual(identity);
  expect(trainingInferencePolicies(config, undefined, registry).optimizer).toEqual([{ provider: 'registered', policy: 'registered-policy' }]);
  const inference = createTrainingInference({ command: 'train', flags: {}, training: config }, { inferenceProviders: registry }, 1000, { prose: 'registered-model' }, { prose: 0 });
  expect(create.mock.calls.map(([, context]) => context.purpose)).toEqual(['judge', 'optimizer']);
  expect(create.mock.calls[0]![1].resources).toBe(create.mock.calls[1]![1].resources);
  expect((await inference.inference.generate({ model: 'registered-model', prompt: 'test' })).text).toBe('done');
  await inference.close();
  expect(close).toHaveBeenCalledOnce();
  const changed = structuredClone(config); changed.models.local.model = 'rejected';
  expect(() => validateTrainingConfiguration(changed, '$.training', registry)).toThrow('registration rejected');
});

it('lists only injected provider ids in registry key order for invalid authored providers', () => {
  const { registry } = registration();
  const descriptor = registry.providers.registered!;
  const injected = { ...registry, providers: { second: descriptor, first: descriptor } };
  expect(() => validateTrainingConfiguration(config, '$.training', injected))
    .toThrow(expect.objectContaining({ message: '$.training.models.local.provider: expected one of second, first' }));
});

it('resolves omitted routes and legacy identity from the selected registry default', async () => {
  const { registry, create, close } = registration();
  const inference = createTrainingInference({ command: 'train', flags: {} }, { inferenceProviders: registry }, 1234, { prose: 'registered-model' }, { prose: 0 });
  expect(create).toHaveBeenCalledWith({ provider: 'registered', model: '' }, expect.objectContaining({ timeoutMs: 1234 }));
  expect(inference.judges.prose!.identity).toBe('registered-legacy');
  expect(configuredCostRoutes({ command: 'train', flags: {} }, { prose: 'm' }, { prose: 0 }, registry).judges.prose!.provider).toBe('registered');
  await inference.close(); expect(close).toHaveBeenCalledOnce();
  expect(() => inferenceProviderDescriptor(registry, 'missing')).toThrow('Unknown inference provider');
});

it('validates the neutral built-ins without invoking their factories during parsing', () => {
  const model = (provider: string, extra: Record<string, unknown> = {}) => ({ models: { one: { provider, model: 'local', ...extra } } });
  expect(validateTrainingConfiguration(model('claude-subscription'))).toBeDefined();
  expect(validateTrainingConfiguration(model('ollama', { think: true, endpoint: 'https://localhost:11434', keep_alive_seconds: 0, context_window: 512, max_output_tokens: 1 }))).toBeDefined();
  for (const extra of [{ reasoning_effort: 'high' }, { unexpected: true }, { model: '' }, { think: 1 }, { keep_alive_seconds: 1.5 },
    { context_window: 511 }, { max_output_tokens: 0 }, { endpoint: 'bad' }, { endpoint: 'ftp://localhost' }, { endpoint: 'http://u:p@host' }, { endpoint: 'http://host?q=x' }, { endpoint: 'http://host#x' }]) {
    expect(() => validateTrainingConfiguration(model('ollama', extra))).toThrow();
  }
  for (const extra of [{ reasoning_effort: 'high' }, { think: true }, { endpoint: 'http://localhost' }]) {
    expect(() => validateTrainingConfiguration(model('claude-subscription', extra))).toThrow();
  }
  expect(inferenceProviderDescriptor(defaultInferenceProviders, 'ollama').create({ provider: 'ollama', model: 'local' },
    { timeoutMs: 1000, purpose: 'judge', resources: new Map(), onClose: () => undefined }).id).toContain('ollama');
  expect(inferenceProviderDescriptor(defaultInferenceProviders, 'claude-subscription').create({ provider: 'claude-subscription', model: 'local' },
    { timeoutMs: 1000, purpose: 'judge', resources: new Map(), onClose: () => undefined }).id).toContain('claude');
});
