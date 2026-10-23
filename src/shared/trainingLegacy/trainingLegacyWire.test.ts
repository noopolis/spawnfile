import { expect, it } from 'vitest';
import { canonicalWireId, compatibleWireLiteral, hasLegacyTrainingDistribution, legacyWireAliases, wireIdMatches } from './trainingLegacyWire.js';

it.each(Object.entries(legacyWireAliases))('reads the exact historical wire id %s', (legacy, current) => {
  expect(compatibleWireLiteral(current).parse(legacy)).toBe(current);
  expect(compatibleWireLiteral(current).parse(current)).toBe(current);
  expect(wireIdMatches(legacy, current)).toBe(true);
  expect(compatibleWireLiteral(current).safeParse(`${legacy}0`).success).toBe(false);
});
it('keeps unknown and non-string discriminators unchanged and rejects unsupported versions', () => {
  for (const value of [null, undefined, 1, {}, 'paideia.dataset.v99', 'paideia.unknown.v1', 'constructor']) {
    expect(canonicalWireId(value)).toBe(value);
    expect(wireIdMatches(value, 'spawnfile.training.dataset.v1')).toBe(false);
    expect(compatibleWireLiteral('spawnfile.training.dataset.v1').safeParse(value).success).toBe(false);
  }
});
it('recognizes former external image authority without accepting it as bundled', () => {
  expect(hasLegacyTrainingDistribution({ build: { paideia: {} }, files: [] })).toBe(true);
  expect(hasLegacyTrainingDistribution({ build: { bridge: {} }, files: [] })).toBe(true);
  expect(hasLegacyTrainingDistribution({ build: {}, files: [{ destination: 'paideia/dist/index.js' }] })).toBe(true);
  expect(hasLegacyTrainingDistribution({ build: { recipe: 'bundled' }, files: [{ destination: 'spawnfile/dist/index.js' }] })).toBe(false);
});
