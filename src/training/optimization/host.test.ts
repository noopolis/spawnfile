import { describe, expect, it } from 'vitest';
import { DspyHost } from './host.js';
import { DSPY_SCHEMA, startSchema, type DspyRequest, type DspyStart } from './protocol.js';
import { simulatedOptions } from './testSupport.js';

export function hostFixture(): { host: DspyHost; options: ReturnType<typeof simulatedOptions>['options']; start: DspyStart } {
  const { options } = simulatedOptions();
  const start = startSchema.parse({ schema: DSPY_SCHEMA, kind: 'optimize', id: options.id,
    components: options.components, trainCaseIds: options.trainCaseIds, validationCaseIds: options.validationCaseIds,
    budget: options.budget, seed: options.seed });
  return { host: new DspyHost(start, options), options, start };
}

export function evaluateRequest(id: string, components: Record<string, string>, split: 'train' | 'validation' = 'train'): DspyRequest {
  return { schema: DSPY_SCHEMA, kind: 'request', id, method: 'evaluate',
    params: { caseId: split === 'train' ? 'train' : 'validation-secret', split, components } };
}

export function generateRequest(id: string, components: Record<string, string>): DspyRequest {
  return { schema: DSPY_SCHEMA, kind: 'request', id, method: 'generate', params: { purpose: 'reflection', options: {},
    messages: [{ role: 'system', content: 'reflect' }, { role: 'user', content: JSON.stringify({
      currentComponents: components, updateOnly: Object.keys(components),
    }) }] } };
}

describe('host-owned native trial and proposal boundary', () => {
  it('rejects changed component sets before policy validation or native work', async () => {
    const { host, start } = hostFixture();
    const signal = new AbortController().signal;
    await expect(host.validate({}, signal)).rejects.toThrow('component set');
    await expect(host.validate({ ...start.components, 'AGENTS.md': 'x', wrong: 'x' }, signal)).rejects.toThrow('component set');
    await expect(host.validate({ A: 'a', B: 'b' }, signal)).rejects.toThrow('component set');
    expect(host.evaluations).toBe(0);
  });

  it('checks split allowlists and callback IDs before any repeated effect', async () => {
    const { host, start } = hostFixture();
    const signal = new AbortController().signal;
    const call = evaluateRequest('call-1', start.components);
    await host.handle(call, signal);
    await expect(host.handle(call, signal)).rejects.toThrow('reused');
    if (call.method !== 'evaluate') throw new Error('test setup');
    await expect(host.handle({ ...call, id: 'other', params: { ...call.params, caseId: 'sealed' } }, signal)).rejects.toThrow('declared split');
    await expect(host.handle({ ...call, id: 'third', params: { ...call.params, split: 'validation' } }, signal)).rejects.toThrow('declared split');
    expect(host.evaluations).toBe(1);
  });

  it('bounds actual failed native and reflection attempts independently', async () => {
    const { host, start, options } = hostFixture();
    const signal = new AbortController().signal;
    start.budget.maxMetricCalls = 1;
    options.evaluate = async () => { throw new Error('native unavailable'); };
    await expect(host.handle(evaluateRequest('one', start.components), signal)).rejects.toThrow('native unavailable');
    options.validateComponents = () => { throw new Error('budget check must precede policy callbacks'); };
    await expect(host.handle(evaluateRequest('two', start.components), signal)).rejects.toThrow('native evaluation budget');
    expect(host.evaluations).toBe(1);
    const other = hostFixture();
    other.start.budget.maxProposals = 1;
    other.options.generate = async () => { throw new Error('quota exhausted'); };
    await expect(other.host.handle(generateRequest('one', start.components), signal)).rejects.toThrow('quota exhausted');
    await expect(other.host.handle(generateRequest('two', start.components), signal)).rejects.toThrow('proposal budget');
    expect(other.host.proposals).toBe(1);
  });

  it('enforces the aggregate bridge callback ceiling', async () => {
    const { host, start } = hostFixture();
    start.budget = { maxMetricCalls: 1, maxProposals: 1 };
    const signal = new AbortController().signal;
    await host.handle(evaluateRequest('one', start.components), signal);
    await host.handle(generateRequest('two', start.components), signal);
    await expect(host.handle(generateRequest('three', start.components), signal)).rejects.toThrow('total callback budget');
  });

  it.each(['feedback', 'output'] as const)('prevents validation %s from reaching reflection', async (field) => {
    const { host, start, options } = hostFixture();
    options.evaluate = async () => ({ score: 1, feedback: '', output: '', captureId: 'capture', [field]: 'sealed selection text' });
    await expect(host.handle(evaluateRequest('one', start.components, 'validation'), new AbortController().signal)).rejects.toThrow('only a scalar');
    expect(host.completed).toEqual([]);
  });

  it('rejects reused captures instead of calling a rescore an independent trial', async () => {
    const { host, start, options } = hostFixture();
    options.evaluate = async () => ({ score: 1, feedback: '', output: '', captureId: 'same-capture' });
    const signal = new AbortController().signal;
    await host.handle(evaluateRequest('one', start.components), signal);
    await expect(host.handle(evaluateRequest('two', start.components), signal)).rejects.toThrow('fresh native captures');
  });
});
it('retains failed inference attempts without sending provider evidence to Python', async () => {
  const { InferenceFailure } = await import('../inference/index.js');
  const { host, options, start } = hostFixture();
  const attempts = [{ id: 'receipt', ordinal: 1, providerId: 'p', requestedModel: 'small', responseModel: null,
    responseRoute: null, outcome: 'failed' as const, failureKind: 'quota' as const, startedAt: 'start', completedAt: 'end', usage: null }];
  options.generate = async () => { throw new InferenceFailure('quota', 'unavailable', { attempts }); };
  await expect(host.handle(generateRequest('failed', start.components), new AbortController().signal)).rejects.toThrow('unavailable');
  expect(host.inferenceAttempts).toEqual(attempts);
});
it('keeps settled attempt receipts when response validation or an outer abort rejects', async () => {
  const attempts = [{ id: 'receipt', ordinal: 1, providerId: 'p', requestedModel: 'small', responseModel: null,
    responseRoute: null, outcome: 'completed' as const, failureKind: null, startedAt: 'start', completedAt: 'end', usage: null }];
  for (const cancel of [false, true]) {
    const { host, options, start } = hostFixture();
    const controller = new AbortController();
    options.generate = async () => {
      if (cancel) controller.abort();
      return { text: '', model: 'm', route: 'p', usage: null, attempts };
    };
    await expect(host.handle(generateRequest('rejected', start.components), controller.signal)).rejects.toThrow();
    await Promise.resolve();
    expect(host.inferenceAttempts).toEqual(attempts);
  }
});

it('reserves evaluation capacity before asynchronous validation and refuses duplicate in-flight IDs', async () => {
  const { host, start, options } = hostFixture();
  start.budget.maxMetricCalls = 1;
  let release!: () => void;
  options.validateComponents = () => new Promise<void>(resolve => { release = resolve; });
  const signal = new AbortController().signal;
  const request = evaluateRequest('reserved', start.components);
  const first = host.handle(request, signal);
  while (!release) await Promise.resolve();
  await expect(host.handle(request, signal)).rejects.toThrow('reused');
  await expect(host.handle(evaluateRequest('second', start.components), signal)).rejects.toThrow('evaluation budget');
  expect(host.evaluations).toBe(0);
  expect(await host.drain(1)).toBe(false);
  release();
  await first;
  expect(await host.drain(10)).toBe(true);
  expect(host.evaluations).toBe(1);
});
