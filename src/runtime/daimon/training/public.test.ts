import { expect, it } from 'vitest';
import { parseNativeLaunch } from './public.js';

it('refuses an unverified native launch through the integration entry point', () => {
  expect(() => parseNativeLaunch({})).toThrow();
});
