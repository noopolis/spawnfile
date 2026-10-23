import { expect, it, vi } from 'vitest';
import { captureInferenceDiagnostic } from './diagnostic.js';
import { InferenceFailure } from './failure.js';
import { createRoutedInference } from './routing.js';
import type { InferenceProvider } from '../contracts/execution.js';

it('retains exact bounded attested text privately and marks oversized responses omitted', () => {
  const diagnostic = captureInferenceDiagnostic('response-schema', 'PRIVATE ANSWER');
  expect(diagnostic.response).toMatchObject({ text: 'PRIVATE ANSWER', bytes: 14, omitted: false });
  expect(diagnostic.response?.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(captureInferenceDiagnostic('response-schema', 'x'.repeat(65_537)).response).toMatchObject({ bytes: 65_537, omitted: true });
  expect(captureInferenceDiagnostic('response-schema', 'x'.repeat(65_537)).response).not.toHaveProperty('text');
  const failure = new InferenceFailure('invalid-response', 'Schema rejected', { diagnostic });
  expect(failure.diagnostic).toEqual(diagnostic);
  expect(JSON.stringify(failure)).not.toContain('PRIVATE ANSWER');
  expect(JSON.stringify({ ...failure })).not.toContain('PRIVATE ANSWER');
  expect(Object.isFrozen(failure.diagnostic?.response)).toBe(true);
  expect(captureInferenceDiagnostic('transport-framing')).toEqual({ code: 'transport-framing' });
  expect(() => captureInferenceDiagnostic('invented' as never)).toThrow();
  expect(() => captureInferenceDiagnostic('tool-isolation', 'PRIVATE TOOL')).toThrow();
  expect(() => captureInferenceDiagnostic('response-schema', 7 as never)).toThrow();
});

const provider = (generate: InferenceProvider['generate']): InferenceProvider => ({ id: 'test', generate,
  capabilities: { tools: 'disabled', billing: 'subscription', temperature: false, seed: false } });
const failure = () => new InferenceFailure('invalid-response', 'Bad schema', { diagnostic: captureInferenceDiagnostic('response-schema', 'PRIVATE FAILURE'),
  usage: { inputTokens: 15_847, outputTokens: 695, cachedInputTokens: 0, reasoningTokens: null, source: 'grok.result.usage.lower-bound' } });

it('audits protected failure once before authored fallback and keeps raw text out of returned result', async () => {
  const observed: unknown[] = [];
  const second = vi.fn(async () => {
    expect(observed).toHaveLength(1);
    return { text: '{"score":0}', model: 'actual', route: 'fallback', usage: null };
  });
  const route = createRoutedInference({ id: 'r', routes: [{ provider: provider(async () => { throw failure(); }), model: 'grok' },
    { provider: provider(second), model: 'fallback' }], maxAttempts: 2, timeoutMs: 500 });
  const result = await route.generate({ prompt: 'p', model: 'unused', observeFailure: value => { observed.push(value); } });
  expect(result.attempts?.[0]).toMatchObject({ failureKind: 'invalid-response', usage: { inputTokens: 15_847, outputTokens: 695 } });
  expect(observed[0]).toMatchObject({ attempt: { id: result.attempts![0]!.id }, diagnostic: { response: { text: 'PRIVATE FAILURE' } } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE FAILURE'); expect(second).toHaveBeenCalledOnce();
});

it.each(['throw', 'hang', 'cancel'] as const)('protected observer %s stops before any fallback within route budget', async mode => {
  const second = vi.fn(); const controller = new AbortController();
  const route = createRoutedInference({ id: 'r', routes: [{ provider: provider(async () => { throw failure(); }), model: 'grok' },
    { provider: provider(second), model: 'fallback' }], maxAttempts: 2, timeoutMs: 20 });
  await expect(route.generate({ prompt: 'p', model: 'unused', signal: controller.signal, observeFailure: async () => {
    if (mode === 'throw') throw Error('PRIVATE SINK');
    if (mode === 'cancel') controller.abort();
    await new Promise(() => undefined);
  } })).rejects.toMatchObject({ kind: mode === 'throw' ? 'unknown' : mode === 'cancel' ? 'cancelled' : 'timeout' });
  expect(second).not.toHaveBeenCalled();
});
