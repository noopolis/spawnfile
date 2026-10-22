import { expect, test, vi } from 'vitest';
import { createDeliveryGate } from '../deliveries.js';
import { matchTransportSource, parseTransportSource } from './source.js';

test('transport descriptors are exact, nonempty and bounded without changing delivery identity', () => {
  for (const value of [null, [], '', {}, { kind: 'manual', deliveryId: 'm:1' }, { kind: 'transport' },
    { kind: 'transport', deliveryId: '' }, { kind: 'transport', deliveryId: 1 }, { kind: 'transport', deliveryId: ' ' },
    { kind: 'transport', deliveryId: 'x'.repeat(16385) }, { kind: 'transport', deliveryId: 'a\n' },
    { kind: 'transport', deliveryId: 'one', deliveryIdPrefix: 'm:' }, { kind: 'transport', deliveryId: 'one', token: 'secret' }]) {
    expect(() => parseTransportSource(value)).toThrow(/source/);
  }
  const exact = parseTransportSource({ kind: 'transport', deliveryId: 'moltnet:1' });
  const prefix = parseTransportSource({ kind: 'transport', deliveryIdPrefix: 'moltnet:' });
  expect(matchTransportSource(exact, 'moltnet:1')).toBe(true);
  expect(matchTransportSource(exact, 'moltnet:10')).toBe(false);
  expect(matchTransportSource(prefix, 'moltnet:2')).toBe(true);
  expect(matchTransportSource(prefix, 'foreign:2')).toBe(false);
});

test('transport gate shares one real deadline and admits at most three sourced continuations', () => {
  const source = { kind: 'transport' as const, deliveryId: 'm:1' };
  const gate = createDeliveryGate(1000, 30, 'transport');
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    expect(() => gate.begin('task', '')).toThrow(/source/);
    expect(gate.begin('task', '', { maxExternalDeliveries: 3 }, { kind: 'transport', deliveryIdPrefix: 'm:' })).toBe(1000);
    expect(gate.finish('e0', true)).toBe(true);
    expect(() => gate.begin('answer', '', {}, { kind: 'transport', deliveryIdPrefix: 'm:' })).toThrow(/exact/);
    for (let i = 1; i <= 3; i++) {
      now.mockReturnValue(1000 + i * 100);
      expect(gate.begin(`answer${i}`, '', {}, { ...source, deliveryId: `m:${i}` })).toBe(1000 - i * 100);
      expect(gate.finish(`e${i}`, true)).toBe(i < 3);
    }
    expect(() => gate.begin('fourth', '', {}, source)).toThrow(/exactly one/);
    const expired = createDeliveryGate(10, 30, 'transport');
    expired.begin('task', '', { maxExternalDeliveries: 1 }, source); expired.finish('one', true);
    now.mockReturnValue(2000);
    expect(() => expired.begin('answer', '', {}, source)).toThrow(/deadline/);
    expect(() => createDeliveryGate(100).begin('task', 'text', {}, source)).toThrow(/Direct delivery/);
  } finally { now.mockRestore(); }
});
