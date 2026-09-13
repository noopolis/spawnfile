import { expect, it, vi } from 'vitest';
import { drainObservations } from './closure.js';

it('bounds a source that continuously replaces its acknowledged tail', async () => {
  const stable = Promise.resolve();
  await expect(drainObservations(() => stable)).resolves.toBeUndefined();
  await expect(drainObservations(() => Promise.resolve())).rejects.toThrow('did not quiesce');
  vi.useFakeTimers();
  let resolve: (() => void) | undefined;
  const stalled = new Promise<void>(done => { resolve = done; });
  const rejected = expect(drainObservations(() => stalled, 100)).rejects.toThrow('deadline');
  await vi.advanceTimersByTimeAsync(100); await rejected;
  resolve!(); await Promise.resolve();
  vi.useRealTimers();
});
