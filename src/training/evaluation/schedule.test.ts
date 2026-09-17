import { describe, expect, it, vi } from 'vitest';
import { result } from './logic/index.js';
import { checkConcurrency, defaultCheckConcurrency, runStageChecks, type StageCheckTask } from './schedule.js';

const pass = (reason: string) => result('pass', reason);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('stage check scheduling', () => {
  it('defaults to a small explicit bound and never exceeds it', async () => {
    expect(checkConcurrency(undefined)).toBe(defaultCheckConcurrency);
    expect(defaultCheckConcurrency).toBeGreaterThanOrEqual(2);
    expect(defaultCheckConcurrency).toBeLessThanOrEqual(4);
    let active = 0, peak = 0;
    const gates = Array.from({ length: 5 }, deferred);
    const tasks: StageCheckTask[] = gates.map((gate, index) => ({ resources: [], run: async () => {
      active++; peak = Math.max(peak, active);
      await gate.promise; active--;
      return pass(`task ${index}`);
    } }));
    const order: number[] = [];
    const running = runStageChecks(tasks, 3, async (_value, index) => { order.push(index); });
    await vi.waitFor(() => expect(active).toBe(3));
    for (const gate of [...gates].reverse()) { gate.resolve(); await new Promise(resolve => setTimeout(resolve, 1)); }
    await running;
    expect(peak).toBe(3);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('starts nothing queued behind a resource once an earlier commit has failed', async () => {
    const shared = {}, first = {};
    const slow = deferred();
    const blocked = vi.fn(async () => pass('must not run'));
    const running = runStageChecks([
      { resources: [first], run: async () => pass('commits and fails') },
      { resources: [shared], run: async () => { await slow.promise; return pass('started before failure'); } },
      { resources: [shared], run: blocked },
    ], 4, async index => { throw new Error(`sink failed at ${index.reason}`); });
    await new Promise(resolve => setTimeout(resolve, 10));
    slow.resolve();
    await expect(running).rejects.toThrow('sink failed at commits and fails');
    expect(blocked).not.toHaveBeenCalled();
  });

  it('never hands a shared resource to a queued check before the holder commit outcome is known', async () => {
    const shared = {};
    const queued = vi.fn(async () => pass('must not run'));
    await expect(runStageChecks([
      { resources: [shared], run: async () => pass('a') },
      { resources: [shared], run: queued },
    ], 4, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      throw new Error('sink failed');
    })).rejects.toThrow('sink failed');
    expect(queued).not.toHaveBeenCalled();
  });

  it('never hands a freed slot to a queued check before the holder commit outcome is known', async () => {
    const slow = deferred();
    const queued = vi.fn(async () => pass('must not run'));
    const running = runStageChecks([
      { resources: [], run: async () => pass('a fails to commit') },
      { resources: [], run: async () => { await slow.promise; return pass('b in flight'); } },
      { resources: [], run: queued },
    ], 2, async value => {
      if (value.reason.startsWith('a')) { await new Promise(resolve => setTimeout(resolve, 5)); throw new Error('sink failed'); }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(queued).not.toHaveBeenCalled();
    slow.resolve();
    await expect(running).rejects.toThrow('sink failed');
    expect(queued).not.toHaveBeenCalled();
  });

  it('stops before independent work that follows a failed dependent commit', async () => {
    const later = vi.fn(async () => pass('must not run'));
    await expect(runStageChecks([
      { resources: undefined, run: async () => pass('dependent') },
      { resources: [], run: later },
      { resources: undefined, run: later },
    ], 2, async () => { throw new Error('sink failed'); })).rejects.toThrow('sink failed');
    expect(later).not.toHaveBeenCalled();
  });

  it('surfaces a rejected run only after work that already started settles', async () => {
    const failing = deferred(), slow = deferred();
    let settled = false;
    const running = runStageChecks([
      { resources: [], run: async () => { await failing.promise; throw new Error('run failed'); } },
      { resources: [], run: async () => { await slow.promise; settled = true; return pass('late'); } },
    ], 2, async () => undefined);
    const outcome = running.then(() => 'resolved', (error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve, 5));
    failing.resolve();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(settled).toBe(false);
    slow.resolve();
    expect(String(await outcome)).toContain('run failed');
    expect(settled).toBe(true);
  });

  it('runs every task inline when the bound is one', async () => {
    const seen: number[] = [];
    let active = 0;
    await runStageChecks([0, 1, 2].map(index => ({ resources: [], run: async () => {
      expect(active).toBe(0); active++;
      await new Promise(resolve => setTimeout(resolve, 1));
      active--; return pass(String(index));
    } })), 1, async (_value, index) => { seen.push(index); });
    expect(seen).toEqual([0, 1, 2]);
  });
});
