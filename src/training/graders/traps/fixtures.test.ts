import { expect, it } from 'vitest';
import { fixture } from './fixtures.js';
import { generateTraps } from './index.js';

it('gives repetition a defect answer and harmless controls the unchanged baseline answer', () => {
  const { templates, document, inputs } = fixture();
  expect(templates.templates[0]!.traps).toEqual({
    'injected-redundancy': 'redundant',
    'format-paraphrase': 'unchanged',
    'option-permutation': 'unchanged',
  });
  const result = generateTraps(templates, document, inputs, {
    baseFinals: { 'supported@c1': 'supported', 'supported@c2': 'supported' },
  });
  for (const [kind, answer] of [
    ['injected-redundancy', 'redundant'],
    ['format-paraphrase', 'unchanged'],
    ['option-permutation', 'unchanged'],
  ] as const) {
    const traps = result.traps.filter(trap => trap.kind === kind);
    expect(traps.length).toBeGreaterThan(0);
    for (const trap of traps) {
      expect(trap.intended_answers).toEqual({ [`supported@${trap.base_unit}`]: answer });
      expect(trap.validation).toEqual({ valid: true, reasons: [] });
    }
  }
});
