import { expect, it } from 'vitest';
import { parseCheckTemplates, trapKinds, type TrapKind } from '../decomposition/index.js';
import { fixture } from './fixtures.js';
import { generateTraps, validateTrap } from './index.js';
import { mutationFor } from './mutations.js';

const removed = ['number-substitution', 'entity-substitution', 'negation-flip', 'citation-swap'];
it.each(removed)('refuses removed %s declarations, generation and serialized variants', kind => {
  const f = fixture();
  expect(trapKinds).not.toContain(kind);
  for (const known_answer of [false, true]) {
    const templates = structuredClone(f.templates);
    templates.templates[0]!.traps = { [kind]: { answer: 'unsupported', known_answer } };
    expect(() => parseCheckTemplates(templates)).toThrow();
    // Direct callers cannot bypass parsing to revive the deleted generator.
    expect(generateTraps(templates, f.document, f.inputs, { baseFinals: { 'supported@c1': 'supported' } }).traps).toEqual([]);
  }
  expect(mutationFor(kind as TrapKind, f.document.units[0]!, f.document, f.inputs, f.templates, '0')).toBeUndefined();
  const trap = generateTraps(f.templates, f.document, f.inputs).traps[0]!;
  expect(trap).toBeDefined();
  const legacy = { ...trap, kind: kind as TrapKind };
  expect(validateTrap(legacy, f.document.units[0]!, f.inputs, f.templates, f.document))
    .toEqual({ valid: false, reasons: ['unsupported trap kind: non-entailment cannot be proven'] });
});
