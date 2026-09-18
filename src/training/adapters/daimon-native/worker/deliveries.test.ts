import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createDeliveryGate, verifyExternalSource, MAX_EXTERNAL_DELIVERIES, MAX_TRIAL_WAKES } from './deliveries.js';
const text = 'Verified answer';
const source = { kind: 'transport', id: 'message-a', sha256: `sha256:${createHash('sha256').update(text).digest('hex')}` };

test('only permits declared sequential sourced continuations after deferred work', () => {
  const gate = createDeliveryGate(1000);
  expect(gate.begin('initial', 'Task', { maxExternalDeliveries: 1 })).toBeGreaterThan(0);
  expect(() => gate.begin('concurrent', 'Task')).toThrow('exactly one');
  expect(gate.finish('execution1', true)).toBe(true);
  expect(() => gate.begin('initial', text, { source })).toThrow('exactly one');
  expect(() => gate.begin('next', text)).toThrow('requires a source');
  expect(() => gate.begin('next', text, { source, maxExternalDeliveries: 2 })).toThrow('cannot change');
  gate.begin('next', text, { source });
  expect(gate.finish('execution2', true)).toBe(false);
  expect(() => gate.begin('third', text, { source })).toThrow('exactly one');
  expect(gate.executions).toEqual(['execution1', 'execution2']);
});

test('does not renew total time, accept bad bounds/source hashes or continue completed work', () => {
  for (const value of [-1, 4, 1.5]) expect(() => createDeliveryGate(1000).begin('wake', text, { maxExternalDeliveries: value })).toThrow('bound');
  expect(() => createDeliveryGate(1000).begin('wake', text, { source })).toThrow('bound');
  expect(() => createDeliveryGate(1000).begin('wake', text, { other: 1 } as never)).toThrow('Unknown');
  expect(() => createDeliveryGate(1000).begin('../', text)).toThrow('Invalid bounded');
  for (const altered of [{ ...source, sha256: 'wrong' }, { ...source, id: '../' }, { ...source, kind: '' }, { ...source, extra: true }]) {
    expect(() => verifyExternalSource(altered, text)).toThrow('source identity');
  }
  const complete = createDeliveryGate(1000);
  complete.begin('one', text, { maxExternalDeliveries: 3 }); complete.finish('a', false);
  expect(() => complete.begin('two', text, { source })).toThrow('exactly one');
  expect(() => complete.finish('a', false)).toThrow('reused');
  const timer = vi.spyOn(Date, 'now').mockReturnValue(100);
  try {
    const timed = createDeliveryGate(10);
    timed.begin('one', text, { maxExternalDeliveries: 1 }); timed.finish(undefined, true);
    timer.mockReturnValue(111);
    expect(() => timed.begin('two', text, { source })).toThrow('deadline');
  } finally { timer.mockRestore(); }
});

test('omitting external controls closes deferred work and forbids another wake', () => {
  const gate = createDeliveryGate(1000);
  gate.begin('initial', 'Task');
  expect(gate.finish('execution1', true)).toBe(false);
  expect(() => gate.begin('next', text, { source })).toThrow('exactly one');
});

/** Drive one gate to the last wake it will admit, at the full delivery budget. */
function exhaust(gate: ReturnType<typeof createDeliveryGate>, advance: (wake: number) => void = () => undefined): number {
  let wakes = 1;
  advance(0);
  gate.begin('w0', 'Task', { maxExternalDeliveries: MAX_EXTERNAL_DELIVERIES });
  while (gate.finish(`e${wakes}`, true)) { advance(wakes); gate.begin(`w${wakes}`, text, { source }); wakes++; }
  return wakes;
}

test('the full budget admits one wake per delivery and then refuses another', () => {
  const gate = createDeliveryGate(60_000);
  // The wake the worker's runtime ceiling is derived from: the task plus its continuations.
  expect(exhaust(gate)).toBe(MAX_TRIAL_WAKES);
  expect(gate.executions).toHaveLength(MAX_TRIAL_WAKES);
  expect(() => gate.begin('extra', text, { source })).toThrow('exactly one');
});

test('the one shared deadline still ends a subject that keeps deferring inside its budget', () => {
  const timer = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    const gate = createDeliveryGate(300);
    // A subject that defers every wake cannot outlive the deadline by having more wakes.
    expect(() => exhaust(gate, wake => timer.mockReturnValue(1000 + wake * 200))).toThrow('deadline');
    expect(gate.executions.length).toBeLessThan(MAX_TRIAL_WAKES);
  } finally { timer.mockRestore(); }
});

test('a declared budget the runtime could never execute is refused instead of admitted', () => {
  // Daimon's per-agent execution policy is the other ceiling that can admit a
  // continuation and then never run it; a budget above it never begins.
  expect(() => createDeliveryGate(1000, MAX_TRIAL_WAKES - 1).begin('one', 'Task', { maxExternalDeliveries: MAX_EXTERNAL_DELIVERIES }))
    .toThrow('fewer executions');
  const bounded = createDeliveryGate(1000, 2);
  expect(bounded.begin('one', 'Task', { maxExternalDeliveries: 1 })).toBeGreaterThan(0);
  expect(bounded.finish('execution1', true)).toBe(true);
});
