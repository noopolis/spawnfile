import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Test-only explicit opt-in: never resolve an ambient npm dependency. */
export function daimonCheckoutRuntime(): string | undefined {
  const checkout = process.env.SPAWNFILE_DAIMON_CHECKOUT;
  if (checkout === undefined) return undefined;
  if (!isAbsolute(checkout)) throw new Error('SPAWNFILE_DAIMON_CHECKOUT must be an absolute built Daimon checkout');
  return pathToFileURL(join(checkout, 'dist/runtime/index.js')).href;
}
