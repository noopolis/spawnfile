import { z } from 'zod';
import legacyWireAliases from './trainingLegacyWireAliases.json' with { type: 'json' };

/** Historical discriminators are translated only at explicit reader boundaries. */
export { legacyWireAliases };

export function canonicalWireId(value: unknown): unknown {
  return typeof value === 'string' && Object.hasOwn(legacyWireAliases, value)
    ? legacyWireAliases[value as keyof typeof legacyWireAliases] : value;
}

/** Validate the exact supported version; unknown versions never become aliases. */
export function compatibleWireLiteral<const T extends string>(current: T) {
  return z.preprocess(canonicalWireId, z.literal(current));
}

export function wireIdMatches(value: unknown, current: string): boolean {
  return canonicalWireId(value) === current;
}

/** Former external image distributions cannot prove the current bundled closure. */
export function hasLegacyTrainingDistribution(image: { build: Record<string, unknown>; files: { destination: string }[] }): boolean {
  return ['paideia', 'bridge'].some(key => Object.hasOwn(image.build, key)) ||
    image.files.some(file => file.destination.startsWith('paideia/'));
}
