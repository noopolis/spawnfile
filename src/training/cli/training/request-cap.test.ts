import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { TrainingConfiguration, TrainingModel } from '../../contracts/index.js';
import { createTrainingInference } from './inference.js';
import { assertModelRequestAdmission } from '../../inference/index.js';

afterEach(() => vi.unstubAllEnvs());
const broker: TrainingModel = { provider: 'grok-broker', model: 'grok-4.6', reasoning_effort: 'low' };
const fake = { id: 'fake', capabilities: { tools: 'disabled' as const, billing: 'subscription' as const,
  temperature: false, seed: false }, generate: vi.fn() };

it.each(['claude-subscription', 'codex-subscription', 'grok-subscription', 'ollama'] as const)(
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


it('budgets explicitly declared Codex proposals and refuses judge reuse before construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proposal-budget-'));
  try {
    const policy = join(root, 'routes.json'), receiptPath = join(root, 'requests.jsonl');
    await writeFile(policy, JSON.stringify({ version: 'paideia.evaluator-routes.v1', receiptPath,
      routes: [{ provider: 'codex-subscription', purpose: 'proposals', model: 'codex-test', maxRequests: 1 }] }));
    vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', 'broker'); vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', policy);
    const generate = vi.fn(async () => ({ text: 'proposal', model: 'codex-test', route: 'subscription', usage: null }));
    const modelInference = vi.fn(() => ({ ...fake, generate }));
    const training: TrainingConfiguration = { models: { optimizer: { provider: 'codex-subscription', model: 'codex-test' } }, optimizer: { model: 'optimizer' } };
    const create = () => createTrainingInference({ command: 'train', flags: {}, training }, { modelInference }, 1000, {}, {});
    expect((await create().inference.generate({ model: 'codex-test', prompt: 'propose' })).text).toBe('proposal');
    await expect(create().inference.generate({ model: 'codex-test', prompt: 'propose' }), 'proposal cap survives provider construction').rejects.toThrow('Routed inference stopped');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await readFile(receiptPath, 'utf8')).toContain('proposals:codex-subscription:codex-test');
    modelInference.mockClear(); training.judges = { prose: { model: 'optimizer' } };
    expect(() => createTrainingInference({ command: 'train', flags: {}, training }, { modelInference }, 1000, { prose: 'codex-test' }, { prose: 0 })).toThrow('unsupported codex-subscription');
    expect(modelInference).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('budgets proposals with a shared judge model and explicit grants without the broker cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-proposal-budget-'));
  try {
    const policy = join(root, 'routes.json'), receiptPath = join(root, 'requests.jsonl');
    await writeFile(policy, JSON.stringify({ version: 'paideia.evaluator-routes.v1', receiptPath,
      routes: [{ provider: 'codex-subscription', purpose: 'proposals', model: 'codex-test', maxRequests: 1 }] }));
    vi.stubEnv('PAIDEIA_MODEL_REQUEST_CAP', undefined); vi.stubEnv('PAIDEIA_EVALUATOR_ROUTES_FILE', policy);
    const generate = vi.fn(async () => ({ text: 'answer', model: 'codex-test', route: 'subscription', usage: null }));
    const modelInference = vi.fn(() => ({ ...fake, generate }));
    const training: TrainingConfiguration = { models: { shared: { provider: 'codex-subscription', model: 'codex-test' } },
      judges: { prose: { model: 'shared' }, second: { model: 'shared' } }, optimizer: { model: 'shared' } };
    const create = () => createTrainingInference({ command: 'train', flags: {}, training }, { modelInference },
      1000, { prose: 'codex-test', second: 'codex-test' }, { prose: 0, second: 0 });
    const configured = create(), request = { model: 'codex-test', prompt: 'request' };
    await configured.judges.prose!.provider.generate(request);
    await configured.inference.generate(request);
    await expect(configured.inference.generate(request), 'shared-model proposal budget guarantee').rejects.toThrow('Routed inference stopped');
    await expect(create().inference.generate(request), 'shared-model resume budget guarantee').rejects.toThrow('Routed inference stopped');
    await configured.judges.second!.provider.generate(request);
    expect(generate).toHaveBeenCalledTimes(3);
    const receipts = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(receipts).toMatchObject([{ event: 'admitted', route: 'proposals:codex-subscription:codex-test' }, { event: 'completed' }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
