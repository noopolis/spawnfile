import { expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createDeliveryGate, verifyExternalSource } from './deliveries.js';
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
