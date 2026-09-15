import { expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../contracts/execution.js';
import { createRoutedInference } from './routing.js';
import { InferenceFailure } from './failure.js';
const result = { text: 'score: 0', model: 'actual', route: 'test', usage: null };
const provider = (generate: InferenceProvider['generate']): InferenceProvider => ({ id: 'p', capabilities: { tools: 'disabled', billing: 'subscription', seed: false, temperature: false }, generate });
const options = (providers: InferenceProvider[]) => ({ id: 'judge', routes: providers.map(p => ({ provider: p, model: 'm' })), maxAttempts: providers.length, timeoutMs: 100 });
it('falls back only on declared infrastructure refusals and audits every settled attempt', async () => {
  const audit = vi.fn();
  const route = createRoutedInference({ ...options([provider(async () => { throw new InferenceFailure('quota', 'busy', { responseModel: 'old' }); }), provider(async () => result)]), observeAttempt: audit });
  const answer = await route.generate({ prompt: 'task', model: 'ignored' });
  expect(answer.attempts).toMatchObject([{ outcome: 'failed', failureKind: 'quota', responseModel: 'old' }, { outcome: 'completed', responseModel: 'actual' }]);
  expect(audit).toHaveBeenCalledTimes(2);
  expect(Object.isFrozen(answer.attempts)).toBe(true);
});
it('does not shop a valid low score and preserves unreported model uncertainty', async () => {
  const next = vi.fn();
  const answer = await createRoutedInference(options([provider(async () => ({ ...result, modelBasis: 'requested-assumption' })), provider(next)])).generate({ prompt: 'p', model: 'm' });
  expect(answer.text).toBe('score: 0'); expect(next).not.toHaveBeenCalled(); expect(answer.attempts?.[0]?.responseModel).toBeNull();
});
it.each(['authentication', 'protocol', 'unsupported', 'unknown', 'cancelled'] as const)('never falls back on %s', async kind => {
  const next = vi.fn();
  await expect(createRoutedInference(options([provider(async () => { throw new InferenceFailure(kind, 'x'); }), provider(next)])).generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind });
  expect(next).not.toHaveBeenCalled();
});
it('stops on arbitrary errors, exhausted routes and failed audit persistence', async () => {
  for (const error of [new Error('secret'), new InferenceFailure('transport', 'x')]) {
    await expect(createRoutedInference(options([provider(async () => { throw error; })])).generate({ prompt: 'p', model: 'm' })).rejects.toBeInstanceOf(InferenceFailure);
  }
  await expect(createRoutedInference({ ...options([provider(async () => result)]), observeAttempt: () => { throw Error('disk'); } }).generate({ prompt: 'p', model: 'm' })).rejects.toThrow('audit persistence');
});
it('bounds cancellation, timeout and invalid requests', async () => {
  const never = provider(async () => new Promise(() => undefined));
  const route = createRoutedInference({ ...options([never]), timeoutMs: 10 });
  await expect(route.generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'timeout' });
  const controller = new AbortController();
  const waiting = route.generate({ prompt: 'p', model: 'm', signal: controller.signal }); controller.abort();
  await expect(waiting).rejects.toMatchObject({ kind: 'cancelled' });
  for (const patch of [{ signal: AbortSignal.abort() }, { seed: 0 }, { temperature: 0 }, { prompt: '' }]) await expect(route.generate({ prompt: 'p', model: 'm', ...patch })).rejects.toBeInstanceOf(InferenceFailure);
});
it('validates finite explicit routes and reports mixed local/subscription billing', () => {
  const valid = options([provider(async () => result)]);
  for (const patch of [{ id: '' }, { routes: [] }, { maxAttempts: 0 }, { maxAttempts: 2 }, { timeoutMs: 0 }, { attemptTimeoutMs: Infinity }, { routes: [{ provider: valid.routes[0]!.provider, model: '-bad' }] }]) expect(() => createRoutedInference({ ...valid, ...patch })).toThrow();
  const local = provider(async () => result); local.capabilities.billing = 'local';
  expect(createRoutedInference(options([local, valid.routes[0]!.provider])).capabilities.billing).toBe('mixed');
  const failure = new InferenceFailure('quota', 'x', { usage: { inputTokens: 2, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null, source: 'test' } });
  expect(Object.isFrozen(failure.usage)).toBe(true);
});
it('bounds a stalled audit store and never begins another route', async () => {
  const next = vi.fn();
  const route = createRoutedInference({ ...options([provider(async () => { throw new InferenceFailure('quota', 'q'); }), provider(next)]),
    timeoutMs: 10, observeAttempt: async () => new Promise(() => undefined) });
  await expect(route.generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'timeout', attempts: [{ failureKind: 'quota' }] });
  expect(next).not.toHaveBeenCalled();
});
it('classifies an expired audit timer even when the wall clock has not reached its deadline', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const next = vi.fn();
  try {
    const route = createRoutedInference({ ...options([provider(async () => { throw new InferenceFailure('quota', 'q'); }), provider(next)]),
      timeoutMs: 10, observeAttempt: async () => new Promise(() => undefined) });
    await expect(route.generate({ prompt: 'p', model: 'm' })).rejects.toMatchObject({ kind: 'timeout', attempts: [{ failureKind: 'quota' }] });
    expect(next).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});
it('cancels an audit wait while retaining the completed attempt', async () => {
  const controller = new AbortController();
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const route = createRoutedInference({ ...options([provider(async () => result)]),
    observeAttempt: async () => { began(); await new Promise(() => undefined); } });
  const waiting = route.generate({ prompt: 'p', model: 'm', signal: controller.signal });
  await started; controller.abort();
  await expect(waiting).rejects.toMatchObject({ kind: 'cancelled', attempts: [{ outcome: 'completed' }] });
});
