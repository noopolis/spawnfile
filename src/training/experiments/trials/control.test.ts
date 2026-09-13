import { afterEach, expect, it, vi } from 'vitest';
import { trialControl } from './control.js';
import type { StopReceipt, SubjectSession } from '../../contracts/execution.js';

afterEach(() => { vi.useRealTimers(); });
const receipt: StopReceipt = { state: 'acknowledged', scope: 'process-group', quiescence: 'confirmed', remoteWork: 'unknown', reason: 'test', detail: 'owned group' };
it('propagates deadlines and cancellation without claiming unacknowledged work stopped', async () => {
  vi.useFakeTimers();
  expect(() => trialControl(0)).toThrow();
  const outer = new AbortController(); const control = trialControl(20, outer.signal);
  expect(await control.receipt()).toBeUndefined();
  control.closeNative('Closure requested before native handle');
  expect((await control.receipt())!.state).toBe('unknown');
  control.attach({ stop: async () => receipt } as unknown as SubjectSession);
  expect(await control.owned(Promise.resolve(4))).toBe(4);
  await vi.advanceTimersByTimeAsync(20);
  expect(control.signal.aborted).toBe(true); expect(control.reason).toContain('deadline');
  expect(await control.receipt()).toEqual(receipt); control.dispose();
  outer.abort();
  const early = trialControl(100, outer.signal); early.attach({ stop: async () => { throw 'stop failed'; } } as unknown as SubjectSession);
  expect((await early.receipt())!.state).toBe('unknown'); early.dispose();
  const stalled = trialControl(10); stalled.attach({ stop: () => new Promise(() => {}) } as unknown as SubjectSession);
  const work = stalled.owned(new Promise(() => {})); const check = expect(work).rejects.toThrow('did not settle');
  await vi.advanceTimersByTimeAsync(10); const stopping = stalled.receipt();
  await vi.advanceTimersByTimeAsync(2_000); await check;
  expect((await stopping)!.quiescence).toBe('unknown');
  const afterAbort = expect(stalled.owned(new Promise(() => {}))).rejects.toThrow('did not settle');
  await vi.advanceTimersByTimeAsync(2_000); await afterAbort; stalled.dispose();
});
