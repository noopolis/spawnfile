import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Test-only built checkout: required in CI, opt-in locally; never an ambient dependency. */
export function daimonCheckoutRuntime(): string | undefined {
  const checkout = process.env.SPAWNFILE_DAIMON_CHECKOUT;
  if (checkout === undefined) {
    if (process.env.CI) throw new Error('CI parity requires SPAWNFILE_DAIMON_CHECKOUT pointing at the built pinned Daimon checkout');
    return undefined;
  }
  if (!isAbsolute(checkout)) throw new Error('SPAWNFILE_DAIMON_CHECKOUT must be an absolute built Daimon checkout');
  return pathToFileURL(join(checkout, 'dist/runtime/index.js')).href;
}
