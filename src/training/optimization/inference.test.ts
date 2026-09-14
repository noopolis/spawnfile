import { describe, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../contracts/execution.js';
import { createDspyGeneration } from './index.js';
import type { DspyGenerateParams } from './protocol.js';

function provider(): InferenceProvider {
  return { id: 'native-subscription', capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false },
    generate: vi.fn(async () => ({ text: 'observed text', model: 'actual-model', usage: null, route: 'native-subscription' })) };
}
function request(): DspyGenerateParams {
  return { purpose: 'reflection', messages: [{ role: 'system', content: '\n system\n' }, { role: 'user', content: ' user\n' }], options: {} };
}

describe('explicit DSPy subscription inference', () => {
  it('maps system and user bytes exactly and retains observed identity/unknown usage', async () => {
    const selected = provider();
    const signal = new AbortController().signal;
    const result = await createDspyGeneration(selected, 'requested-model')(request(), signal);
    expect(selected.generate).toHaveBeenCalledExactlyOnceWith({ system: '\n system\n', prompt: ' user\n', model: 'requested-model', signal });
    expect(result).toEqual({ text: 'observed text', model: 'actual-model', usage: null, route: 'native-subscription' });
  });

  it.each([{ tools: 'enabled' }])('rejects an incompatible route: %j', (patch) => {
    const selected = provider();
    Object.assign(selected.capabilities, patch);
    expect(() => createDspyGeneration(selected, 'model')).toThrow('inference route');
    expect(selected.generate).not.toHaveBeenCalled();
  });

  it('rejects missing model, unrepresentable message roles and controls without calling inference', async () => {
    const selected = provider();
    expect(() => createDspyGeneration(selected, ' ')).toThrow('explicit model');
    const generate = createDspyGeneration(selected, 'model');
    const signal = new AbortController().signal;
    const original = request();
    for (const messages of [[], original.messages.slice(1), [...original.messages, { role: 'assistant' as const, content: 'a' }],
      [{ role: 'user' as const, content: 'a' }, { role: 'user' as const, content: 'b' }],
      [{ role: 'system' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }]]) {
      await expect(generate({ ...original, messages }, signal)).rejects.toThrow();
    }
    const unsupported = { ...original, options: { seed: 7 } } as unknown as DspyGenerateParams;
    await expect(generate(unsupported, signal)).rejects.toThrow();
    await expect(generate(original, AbortSignal.abort())).rejects.toThrow();
    expect(selected.generate).not.toHaveBeenCalled();
  });

  it('propagates auth/quota failures and rejects fabricated incomplete inference results', async () => {
    const selected = provider();
    selected.generate = vi.fn(async () => { throw new Error('quota exhausted'); });
    await expect(createDspyGeneration(selected, 'model')(request(), new AbortController().signal)).rejects.toThrow('quota exhausted');
    selected.generate = vi.fn(async () => ({ text: '', model: '', usage: null, route: '' }));
    await expect(createDspyGeneration(selected, 'model')(request(), new AbortController().signal)).rejects.toThrow();
  });
});

it.each(['local', 'mixed', 'api'] as const)('accepts explicitly selected %s providers without imposing sampling controls', async billing => {
  const selected = provider(); selected.capabilities.billing = billing;
  selected.capabilities.temperature = true; selected.capabilities.seed = true;
  const result = await createDspyGeneration(selected, 'model')(request(), new AbortController().signal);
  expect(result.text).toBe('observed text');
});
it('retains route evidence when a completed generation fails optimizer response validation', async () => {
  const selected = provider();
  const attempts = [{ id: 'receipt', ordinal: 1, providerId: 'local', requestedModel: 'small', responseModel: null,
    responseRoute: 'local', outcome: 'completed' as const, failureKind: null, startedAt: 'start', completedAt: 'end', usage: null }];
  selected.generate = async () => ({ text: '', model: 'requested', modelBasis: 'requested-assumption', route: 'local', usage: null, attempts });
  await expect(createDspyGeneration(selected, 'model')(request(), new AbortController().signal))
    .rejects.toMatchObject({ kind: 'protocol', attempts, responseModel: null, responseRoute: 'local' });
});
