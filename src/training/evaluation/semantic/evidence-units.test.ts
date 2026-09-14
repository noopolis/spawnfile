import { expect, it } from 'vitest';
import { evidenceUnits } from './evidence-units.js';

it('preserves all primitive values, empty containers and escaped source pointers deterministically', () => {
  const input = { 'a/~': [null, true, 3, '', [], {}], z: 'text' };
  const first = evidenceUnits({ input, evidence: 'source' });
  expect(evidenceUnits({ evidence: 'source', input: { z: 'text', 'a/~': input['a/~'] } })).toEqual(first);
  expect(first.units.map(unit => unit.value)).toEqual(['source', null, true, 3, '', [], {}, 'text']);
  expect(first.units[1]!.pointer).toBe('/a~1~0/0');
  expect(first.units.every(unit => /^e-[a-f0-9]{20}$/u.test(unit.id) && /^sha256:[a-f0-9]{64}$/u.test(unit.digest))).toBe(true);
  expect(evidenceUnits({ input: 'source' }).units[0]!.id).not.toBe(first.units[0]!.id);
  expect(evidenceUnits({ evidence: 'different' }).units[0]!.id).not.toBe(first.units[0]!.id);
});
it('chunks Unicode strings losslessly including exact boundary lengths', () => {
  for (const size of [2048, 4097]) {
    const value = '🙂'.repeat(size), units = evidenceUnits({ input: value }).units;
    expect(units.map(unit => unit.value).join('')).toBe(value);
    expect(units.map(unit => unit.chunk)).toEqual(size === 2048 ? [0] : [0, 1, 2]);
    expect(units.every(unit => [...String(unit.value)].length <= 2048)).toBe(true);
  }
});
it('rejects oversized, invalid, cyclic and deeply nested evidence instead of dropping it', () => {
  for (const value of [undefined, Infinity, NaN, () => {}, { nested: undefined }]) expect(() => evidenceUnits({ input: value })).toThrow('finite JSON');
  expect(() => evidenceUnits({ input: Array(257).fill('') })).toThrow('bounded packet');
  expect(() => evidenceUnits({ input: '🙂'.repeat(65536) })).toThrow('bounded packet');
  for (const value of [new Date(), new Map()]) expect(() => evidenceUnits({ input: value })).toThrow('plain JSON');
  expect(evidenceUnits({ input: Object.create(null) }).units[0]!.value).toEqual({});
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  expect(() => evidenceUnits({ input: cyclic })).toThrow('Cyclic');
  let deep: unknown = null; for (let i = 0; i < 66; i++) deep = [deep];
  expect(() => evidenceUnits({ input: deep })).toThrow('nesting');
  const shared = { value: 'same' };
  expect(evidenceUnits({ input: [shared, shared] }).units).toHaveLength(2);
});
