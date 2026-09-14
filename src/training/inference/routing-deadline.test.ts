import { afterEach, expect, it, vi } from 'vitest';
import type { InferenceProvider } from '../contracts/execution.js';
import { createRoutedInference } from './routing.js';
import { InferenceFailure } from './failure.js';

const answer = { text: 'done', model: 'actual', route: 'test', usage: null };
const provider = (id: string, generate: InferenceProvider['generate']): InferenceProvider => ({ id,
  capabilities: { tools: 'disabled', billing: 'subscription', seed: false, temperature: false }, generate });
const pending = (signal?: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(new InferenceFailure('cancelled', 'native stopped')), { once: true });
});
afterEach(() => vi.useRealTimers());

it('reserves fallback time by default, aborts the primary and retains both attempt receipts', async () => {
  vi.useFakeTimers();
  const audit = vi.fn();
  let primarySignal: AbortSignal | undefined;
  const backup = vi.fn(async () => answer);
  const route = createRoutedInference({ id: 'optimizer', timeoutMs: 180000, maxAttempts: 2,
    routes: [{ model: 'grok', provider: provider('first', async request => { primarySignal = request.signal; return pending(request.signal); }) },
      { model: 'claude', provider: provider('second', backup) }], observeAttempt: audit });
  const result = route.generate({ prompt: 'compile', model: 'ignored' });
  await vi.advanceTimersByTimeAsync(89999);
  expect(backup).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({ attempts: [
    { ordinal: 1, requestedModel: 'grok', failureKind: 'timeout', usage: null },
    { ordinal: 2, requestedModel: 'claude', outcome: 'completed' },
  ] });
  expect(primarySignal?.aborted).toBe(true);
  expect(audit).toHaveBeenCalledTimes(2);
});

it('passes unused time forward and never exceeds the overall deadline when every route hangs', async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const third = vi.fn(async request => pending(request.signal));
  const route = createRoutedInference({ id: 'judge', timeoutMs: 120, maxAttempts: 3,
    routes: [{ model: 'first', provider: provider('first', async () => { throw new InferenceFailure('unavailable', 'offline'); }) },
      { model: 'second', provider: provider('second', async request => pending(request.signal)) },
      { model: 'third', provider: provider('third', third) }] });
  const result = route.generate({ prompt: 'judge', model: 'ignored' });
  const rejected = expect(result).rejects.toMatchObject({ kind: 'timeout', attempts: [
    { failureKind: 'unavailable' }, { failureKind: 'timeout' }, { failureKind: 'timeout' },
  ] });
  await vi.advanceTimersByTimeAsync(59);
  expect(third).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(third).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60);
  await rejected;
  expect(Date.now() - started).toBe(120);
});

it('honors an explicit attempt cap and preserves provider-reported timeout usage', async () => {
  vi.useFakeTimers();
  const usage = { inputTokens: 5, outputTokens: 2, cachedInputTokens: null, reasoningTokens: null, source: 'native' };
  const route = createRoutedInference({ id: 'judge', timeoutMs: 100, attemptTimeoutMs: 10, maxAttempts: 3,
    routes: [{ model: 'first', provider: provider('first', async () => { throw new InferenceFailure('timeout', 'native timeout', { usage }); }) },
      { model: 'second', provider: provider('second', async request => pending(request.signal)) },
      { model: 'third', provider: provider('third', async () => answer) }] });
  const result = route.generate({ prompt: 'judge', model: 'ignored' });
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ attempts: [{ failureKind: 'timeout', usage }, { failureKind: 'timeout' }, { outcome: 'completed' }] });
});

it('does not launch a fallback after operator cancellation or a consumed deadline', async () => {
  vi.useFakeTimers();
  const backup = vi.fn(async () => answer);
  const controller = new AbortController();
  const route = createRoutedInference({ id: 'judge', timeoutMs: 100, maxAttempts: 2,
    routes: [{ model: 'first', provider: provider('first', async request => pending(request.signal)) },
      { model: 'second', provider: provider('second', backup) }] });
  const result = route.generate({ prompt: 'judge', model: 'ignored', signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toMatchObject({ kind: 'cancelled' });
  expect(backup).not.toHaveBeenCalled();
  const expired = createRoutedInference({ id: 'expired', timeoutMs: 100, maxAttempts: 2,
    routes: [{ model: 'first', provider: provider('first', async () => {
      vi.setSystemTime(Date.now() + 100); throw new InferenceFailure('timeout', 'elapsed');
    }) }, { model: 'second', provider: provider('second', backup) }] });
  await expect(expired.generate({ prompt: 'judge', model: 'ignored' })).rejects.toMatchObject({ kind: 'timeout', attempts: [{ failureKind: 'timeout' }] });
  expect(backup).not.toHaveBeenCalled();
});

it('retains known timeout usage from a provider that rejects synchronously on abort', async () => {
  vi.useFakeTimers();
  const usage = { inputTokens: 13, outputTokens: 4, cachedInputTokens: 2, reasoningTokens: null, source: 'abort-receipt' };
  const route = createRoutedInference({ id: 'judge', timeoutMs: 100, maxAttempts: 2,
    routes: [{ model: 'first', provider: provider('first', request => new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new InferenceFailure('cancelled', 'stopped', {
        usage, responseModel: 'reported', responseRoute: 'subscription',
      })), { once: true });
    })) }, { model: 'second', provider: provider('second', async () => answer) }] });
  const result = route.generate({ prompt: 'judge', model: 'ignored' });
  await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ attempts: [{ failureKind: 'timeout', usage, responseModel: 'reported', responseRoute: 'subscription' },
    { outcome: 'completed' }] });
});
