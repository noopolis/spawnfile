import { expect, it } from 'vitest';
import { planCallAdmission, escalationCallKey } from './admission.js';

it('groups requested projections in order with an independent budget per output', () => {
  const calls = [
    { outputId: 'one', projectionDigest: 'b' }, { outputId: 'one', projectionDigest: 'a' },
    { outputId: 'one', projectionDigest: 'b' }, { outputId: 'two', projectionDigest: 'a' },
  ];
  expect(planCallAdmission(calls, 1)).toEqual([
    { ...calls[0], admitted: true }, { ...calls[1], admitted: false }, { ...calls[3], admitted: true },
  ]);
  expect(planCallAdmission(calls).every(call => call.admitted)).toBe(true);
  expect(planCallAdmission([])).toEqual([]);
  expect(escalationCallKey({ outputId: 'a:b', projectionDigest: 'c' }))
    .not.toBe(escalationCallKey({ outputId: 'a', projectionDigest: 'b:c' }));
  for (const limit of [0, -1, 1.5, NaN]) expect(() => planCallAdmission(calls, limit)).toThrow('positive integer');
});
