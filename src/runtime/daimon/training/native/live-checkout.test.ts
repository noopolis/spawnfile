import { afterEach, expect, test, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { daimonCheckoutRuntime } from './live-checkout.js';

afterEach(() => vi.unstubAllEnvs());
test('live checks require an explicit absolute built checkout, never an ambient dependency', () => {
  vi.stubEnv('CI', undefined);
  vi.stubEnv('SPAWNFILE_DAIMON_CHECKOUT', undefined);
  expect(daimonCheckoutRuntime()).toBeUndefined();
  vi.stubEnv('SPAWNFILE_DAIMON_CHECKOUT', 'relative');
  expect(daimonCheckoutRuntime).toThrow('absolute');
  vi.stubEnv('SPAWNFILE_DAIMON_CHECKOUT', '/tmp/explicit checkout');
  expect(daimonCheckoutRuntime()).toBe(pathToFileURL('/tmp/explicit checkout/dist/runtime/index.js').href);
});

test('CI fails loudly when its built parity checkout is missing', () => {
  vi.stubEnv('CI', 'true');
  vi.stubEnv('SPAWNFILE_DAIMON_CHECKOUT', undefined);
  expect(daimonCheckoutRuntime).toThrow('CI parity requires SPAWNFILE_DAIMON_CHECKOUT');
});
