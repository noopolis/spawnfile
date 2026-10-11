import { expect, it } from 'vitest';
import { instantiateChecks, validateDecomposition } from '../decomposition/index.js';
import { fixture } from './fixtures.js';
import { generateTraps, validateTrap } from './index.js';
import { replaceLeaf } from './mutations.js';
import type { Trap } from './types.js';

function repeated(kind: 'number-substitution' | 'entity-substitution') {
  const f = fixture();
  const text = kind === 'number-substitution'
    ? 'Dr Alice reported 1,000 items and 1000 items and 1,000 items [R1].'
    : 'Dr Alice met Dr Alice and Dr Alice [R1].';
  f.inputs.output = { body: [text, 'Dr Bob was promoted [R2].'] };
  f.inputs.context.evidence = `## R1\n${text.replace(' [R1]', '')}\n## R2\nDr Bob was promoted.`;
  f.document.units[0]!.text = text;
  f.document.units[0]!.fields = { actor: 'Dr Alice', object: text.replace(' [R1].', '') };
  delete f.document.units[0]!.source_span;
  const traps = generateTraps(f.templates, f.document, f.inputs,
    { baseFinals: { 'supported@c1': 'supported', 'supported@c2': 'supported' } });
  return { ...f, trap: traps.traps.find(trap => trap.base_unit === 'c1' && trap.kind === kind)! };
}
it.each(['number-substitution', 'entity-substitution'] as const)('replaces every original fact and field occurrence: %s', kind => {
  const f = repeated(kind);
  expect(f.trap).toBeDefined();
  const { value_before: before, value_after: after, replacement } = f.trap.mutation;
  expect(replacement).not.toContain(before);
  if (kind === 'number-substitution') expect(replacement).not.toContain('1000');
  expect(replacement.split(after!).length - 1).toBe(3);
  const unit = f.trap.decomposition.units[0]!;
  expect(unit.text).toBe(replacement);
  expect(unit.fields!.object).toBe(replacement.replace(' [R1].', ''));
  expect(validateTrap(f.trap, f.document.units[0]!, f.inputs, f.templates, f.document).valid).toBe(true);
});
it.each(['number-substitution', 'entity-substitution'] as const)('independently rejects a coherent partial substitution: %s', kind => {
  const f = repeated(kind);
  expect(f.trap).toBeDefined();
  const trap: Trap = structuredClone(f.trap);
  trap.mutation.replacement = trap.mutation.source.replace(trap.mutation.value_before!, trap.mutation.value_after!);
  trap.mutation.after = trap.mutation.before.replace(trap.mutation.source, trap.mutation.replacement);
  trap.output = replaceLeaf(f.inputs.output, trap.mutation.path, trap.mutation.after);
  trap.decomposition.units[0]!.text = trap.mutation.replacement;
  trap.decomposition.units[0]!.fields = { actor: kind === 'entity-substitution' ? trap.mutation.value_after! : 'Dr Alice',
    object: trap.mutation.replacement.replace(' [R1].', '') };
  trap.decomposition = validateDecomposition(trap.decomposition, { ...f.inputs, output: trap.output }, f.templates).decomposition;
  trap.instances = instantiateChecks(f.templates, trap.decomposition, { ...f.inputs, output: trap.output });
  // Deliberately omit base metadata comparison: the independent lexical guard must reject it itself.
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toContain('original value remains in mutated claim');
});
it.each(['DR ALICE', 'Dr\tAlice', 'dR \n ALICE'])('independently detects entity survival after normalization: %s', survivor => {
  const f = repeated('entity-substitution');
  const trap = structuredClone(f.trap);
  const before = trap.mutation.value_before!, after = trap.mutation.value_after!;
  trap.mutation.source = trap.mutation.source.replace(before, survivor);
  trap.mutation.before = trap.mutation.source;
  f.document.units[0]!.text = trap.mutation.source;
  f.inputs.output = replaceLeaf(f.inputs.output, trap.mutation.path, trap.mutation.source);
  trap.mutation.replacement = trap.mutation.source.replaceAll(before, after);
  trap.mutation.after = trap.mutation.replacement;
  trap.output = replaceLeaf(f.inputs.output, trap.mutation.path, trap.mutation.after);
  trap.decomposition.units[0]!.text = trap.mutation.replacement;
  trap.decomposition.units[0]!.fields = { actor: after };
  trap.decomposition = validateDecomposition(trap.decomposition, { ...f.inputs, output: trap.output }, f.templates).decomposition;
  trap.instances = instantiateChecks(f.templates, trap.decomposition, { ...f.inputs, output: trap.output });
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toEqual(['original value remains in mutated claim']);
});
