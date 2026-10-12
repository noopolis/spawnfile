import { expect, it } from 'vitest';
import { fixture } from './fixtures.js';
import { generateTraps } from './index.js';

const baseFinals = { 'supported@c1': 'supported', 'supported@c2': 'supported' };
it('requires an expected base final before generating any defect', () => {
  const f = fixture();
  for (const finals of [undefined, {}, { 'supported@c1': null }, { 'supported@c1': 'unsupported' }] as (Record<string, string | null> | undefined)[]) {
    const result = generateTraps(f.templates, f.document, f.inputs, { baseFinals: finals });
    expect(result.traps.every(trap => ['option-permutation', 'format-paraphrase'].includes(trap.kind))).toBe(true);
    expect(result.rejections.some(item => item.reason.includes('baseline final'))).toBe(true);
  }
  expect(generateTraps(f.templates, f.document, f.inputs, { baseFinals }).traps.some(trap => trap.kind === 'injected-redundancy')).toBe(true);
});
