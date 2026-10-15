import { expect, it } from 'vitest';
import { testRepeatCount } from './training-config.js';

it('defaults to one and accepts bounded repeat counts', () => {
  expect(testRepeatCount()).toBe(1);
  for (const count of [1, 3, 8]) expect(testRepeatCount(count)).toBe(count);
});

it.each([0, -1, 9, 1.5, NaN, Infinity, '3', null, true])('rejects invalid held-out repeats %s', count => {
  expect(() => testRepeatCount(count as number)).toThrow('test_repeats');
});
