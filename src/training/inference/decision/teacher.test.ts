import { expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../../contracts/execution.js';
import type { DecisionRequest } from '../../contracts/grading.js';
import { createTeacherDecision } from './index.js';

const request: DecisionRequest = { key: 'q', type: 'yes-no', optionLabels: ['yes', 'no'], expectedOptions: ['no'], instructions: 'Question?', projection: { text: 'data' } };
const provider = (text: string): InferenceProvider => ({ id: 'claude-subscription', capabilities: { billing: 'subscription', tools: 'disabled', temperature: false, seed: false },
  generate: vi.fn(async () => ({ text, model: 'actual', usage: null, route: 'claude-subscription' })) });
it('answers as one-hot and sends strict schema without expected-answer metadata', async () => {
  const fake = provider('{"q":"yes"}');
  const backend = createTeacherDecision({ provider: fake, model: 'opus' });
  expect(await backend.identity()).toEqual({ backend: 'teacher', model: 'claude-subscription:opus' });
  expect(await backend.score([request])).toMatchObject([{ key: 'q', status: 'ok', teacherAnswered: true, probabilities: { yes: 1, no: 0 },
    judgeCalls: [{ providerId: fake.id, responseModel: 'actual', billing: 'subscription', outcome: 'completed', wallMs: expect.any(Number) }] }]);
  const call = vi.mocked(fake.generate).mock.calls[0]![0];
  expect(call.responseSchema).toEqual({ type: 'object', properties: { q: { type: 'string', enum: ['yes', 'no', 'abstain'] } }, required: ['q'], additionalProperties: false });
  expect(call.prompt).not.toContain('expected');
  expect(call.temperature).toBeUndefined();
  expect(await backend.score([])).toEqual([]);
});
it.each(['{"q":"abstain"}', '{}', '{"q":"yes","extra":1}', '{"q":"yes","q":"no"}', 'bad'])('reports absent/invalid answer %s', async text => {
  expect((await createTeacherDecision({ provider: provider(text), model: 'opus' }).score([request]))[0]).toMatchObject({ status: 'missing', probabilities: null, teacherAnswered: true });
});
it('accepts Grok, refuses other billing/tools/providers and invalid model', () => {
  const fake = provider('');
  expect(createTeacherDecision({ provider: { ...fake, id: 'grok-subscription' }, model: 'grok' })).toBeDefined();
  for (const patch of [{ id: 'codex-subscription' }, { capabilities: { ...fake.capabilities, billing: 'api' as const } }, { capabilities: { ...fake.capabilities, tools: 'enabled' as 'disabled' } }]) {
    expect(() => createTeacherDecision({ provider: { ...fake, ...patch }, model: 'm' })).toThrow(/attestation/);
  }
  for (const model of ['', '-bad']) expect(() => createTeacherDecision({ provider: fake, model })).toThrow(/model/);
});
it('reports provider failure and propagates explicit cancellation', async () => {
  const controller = new AbortController();
  const fake = provider('');
  fake.generate = async () => { throw Error('provider'); };
  const backend = createTeacherDecision({ provider: fake, model: 'm' });
  expect((await backend.score([request]))[0]!.status).toBe('missing');
  controller.abort();
  await expect(backend.score([request], controller.signal)).rejects.toThrow('provider');
});
it('retains failed call evidence and never claims an assumed response model', async () => {
  const fake = provider('{"q":"yes"}');
  fake.generate = async () => ({ text: '{"q":"yes"}', model: 'm', modelBasis: 'requested-assumption', route: 'r', usage: null });
  const backend = createTeacherDecision({ provider: fake, model: 'm' });
  expect((await backend.score([request]))[0]!.judgeCalls![0]!.responseModel).toBeNull();
  const { InferenceFailure } = await import('../index.js');
  fake.generate = async () => { throw new InferenceFailure('transport', 'failed', { responseModel: 'actual', responseRoute: 'r' }); };
  expect((await backend.score([request]))[0]!.judgeCalls![0]).toMatchObject({ responseModel: 'actual', responseRoute: 'r', failureKind: 'transport' });
});
