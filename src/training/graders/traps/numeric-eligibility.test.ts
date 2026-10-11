import { expect, it } from 'vitest';
import { instantiateChecks, validateDecomposition } from '../decomposition/index.js';
import { fixture } from './fixtures.js';
import { generateTraps, validateTrap } from './index.js';
import { mutationFor, replaceLeaf } from './mutations.js';
import { exactNumber, numeric } from './preconditions.js';
import type { Trap } from './types.js';

const baseFinals = { 'supported@c1': 'supported', 'supported@c2': 'supported' };
function claim(text: string, evidence = 'Dr Alice received 10 dollars.') {
  const f = fixture();
  text = `${text} [R1].`;
  f.inputs.output = { body: [text, 'Dr Bob was promoted [R2].'] };
  f.inputs.context.evidence = `## R1\n${evidence}\n## R2\nDr Bob was promoted.`;
  f.document.units[0] = { id: 'c1', kind: 'claim', text, paragraph: 0, cites: ['R1'],
    fields: { actor: 'Dr Alice', object: text.replace(' [R1].', '') } };
  return f;
}
function constructed(f: ReturnType<typeof claim>) {
  return mutationFor('number-substitution', f.document.units[0]!, f.document, f.inputs, f.templates, '0');
}
function generated(f: ReturnType<typeof claim>) {
  return generateTraps(f.templates, f.document, f.inputs, { baseFinals }).traps
    .find(t => t.base_unit === 'c1' && t.kind === 'number-substitution')!;
}
/** Rebuild serialized artifacts without calling generation for the forged claim. */
function forged(f: ReturnType<typeof claim>, replacement: string, before = '10', after = '11'): Trap {
  const trap = generated(claim('Dr Alice received 10 dollars'));
  trap.mutation = { path: ['body', '0'], before: f.document.units[0]!.text,
    source: f.document.units[0]!.text, after: replacement, replacement, value_before: before, value_after: after };
  trap.output = replaceLeaf(f.inputs.output, trap.mutation.path, replacement);
  trap.decomposition = structuredClone(f.document);
  trap.decomposition.units[0]!.text = replacement;
  trap.decomposition.units[0]!.fields = { actor: 'Dr Alice', object: replacement.replace(' [R1].', '') };
  trap.decomposition = validateDecomposition(trap.decomposition, { ...f.inputs, output: trap.output }, f.templates).decomposition;
  trap.instances = instantiateChecks(f.templates, trap.decomposition, { ...f.inputs, output: trap.output });
  // All forged fixtures use the same evidence as the generated seed.
  return trap;
}

it.each([
  ['10 or 10.0 or 10.00', '10'],
  ['10.00 or 10 or 10.0', '10.00'],
  ['1,000 or 1000.0 or 1,000.00', '1000'],
  ['10% or 10.0% or 10.00%', '10%'],
])('replaces all parsed equivalents in construction, fields and validation: %s', (values, evidence) => {
  const f = claim(`Dr Alice received ${values} dollars`, `Dr Alice received ${evidence} dollars.`);
  const mutation = constructed(f)!;
  expect(mutation).toBeDefined();
  expect(mutation.replacement.split(mutation.value_after!).length - 1).toBe(3);
  const trap = generated(f);
  expect(trap).toBeDefined();
  expect(trap.decomposition.units[0]!.fields!.object).toBe(mutation.replacement.replace(' [R1].', ''));
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates, f.document).valid).toBe(true);
});
it.each(['10.0', '10.00', '10.00%'])('independently rejects surviving decimal values: %s', survivor => {
  const f = claim(`Dr Alice received 10 or ${survivor} dollars`);
  const trap = forged(f, f.document.units[0]!.text.replace('10 or', '11 or'));
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toEqual(['original value remains in mutated claim']);
});
it('compares cited numbers by value when selecting replacements', () => {
  const f = claim('Dr Alice received 10 dollars', 'Dr Alice received 10.00, 11.0, 12.00, 9.0 and 8.00 dollars.');
  expect(constructed(f)).toBeUndefined();
  const clean = claim('Dr Alice received 10 dollars');
  const trap = forged(clean, 'Dr Alice received 11 dollars [R1].');
  expect(validateTrap(trap, clean.document.units[0]!, clean.inputs, clean.templates).valid).toBe(true);
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toContain('numeric value already in cited evidence');
});

const qualified = ['at most 10', 'at least 10', 'up to 10', 'more than 10', 'less than 10',
  'over 10', 'under 10', 'above 10', 'below 10', 'about 10', 'around 10', 'roughly 10',
  'nearly 10', 'almost 10', 'approximately 10', 'some 10', '~10', '~ 10',
  'AT\tMOST 10', 'about $10', '10-12', '8-10', '10–12', '8—10', '10 to 12',
  'between 10 and 12', 'between 8 and 10', 'between 8 dollars and 10',
  '10%-12%', 'between 8% and 10%', '10 or about 10.00'];
it.each(qualified)('rejects non-exact values at construction and independent validation: %s', quantity => {
  const f = claim(`Dr Alice received ${quantity} dollars`);
  expect(constructed(f)).toBeUndefined();
  expect(generated(f)).toBeUndefined();
  const replacement = f.document.units[0]!.text.replace(/10(?:\.00)?/g, '11');
  const trap = forged(f, replacement);
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toEqual(['number is bounded, approximate or part of a range']);
});
it('targets only equal-valued quantities and ignores citation qualifiers', () => {
  expect(exactNumber('Dr Alice received 10 and 12 dollars', '10')).toBe(true);
  expect(exactNumber('Dr Alice received about 20 dollars and 10 items', '10')).toBe(true);
  expect(exactNumber('Dr Alice received 10 dollars, and 12 items', '10')).toBe(true);
  const f = claim('Dr Alice received 10 dollars');
  f.templates.context.evidence!.rows!.cite = '\\[about (R[0-9]+)\\]';
  f.document.units[0]!.text = 'Dr Alice received [about R1] 10 dollars.';
  f.inputs.output = { body: [f.document.units[0]!.text] };
  expect(constructed(f)).toBeDefined();
  expect(numeric('1,000.00')).toBe(1000);
});
