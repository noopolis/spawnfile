import { describe, expect, it } from 'vitest';
import { parseCheckTemplates, parseDecomposition, trapKinds } from '../decomposition/index.js';
import type { CheckTemplates, Decomposition, DecompositionInputs, TrapKind } from '../decomposition/index.js';
import { generateTraps, validateTrap } from './index.js';
import type { Trap } from './index.js';
import { flipNegation, formatParaphrase, keyTerms, locateSpan, mutationFor, replaceLeaf } from './mutations.js';

function fixture(): { templates: CheckTemplates; document: Decomposition; inputs: DecompositionInputs } {
  const templates = parseCheckTemplates({ schema: 'paideia.check-templates.v1', context: {
    evidence: { rows: { heading: '^## (R[0-9]+)$', cite: '\\[(R[0-9]+)\\]' } } }, templates: [{
    id: 'supported', applies_to: 'claim', type: 'choice', instructions: 'Check {unit.text} {unit.fields.actor} {unit.fields.quantity}',
    criteria: { supported: 'Supported', unsupported: 'Unsupported', redundant: 'Redundant' }, expected: ['supported'],
    state: ['unit', 'unit.cited_rows'], dimension: 'accuracy', severity: 'major',
    traps: Object.fromEntries(trapKinds.map(kind => [kind, ['format-paraphrase', 'option-permutation'].includes(kind) ? 'unchanged' : kind === 'injected-redundancy' ? 'redundant' : 'unsupported'])),
  }] });
  const inputs = { output: { headline: 'Work update', body: ['Alice is paid 1,000 dollars [R1].', 'Bob was promoted [R2].'] },
    context: { evidence: '## R1\nAlice is paid 1,000 dollars.\n## R2\nBob was promoted.' } };
  const document = parseDecomposition({ schema: 'paideia.decomposition.v1', output: { from: 'out.json', sha256: 'b'.repeat(64) }, context: {},
    units: [
      { id: 'c1', kind: 'claim', text: inputs.output.body[0], paragraph: 0, cites: ['R1'], fields: { actor: 'Alice', quantity: '1,000' }, source_span: inputs.output.body[0] },
      { id: 'c2', kind: 'claim', text: inputs.output.body[1], paragraph: 1, cites: ['R2'], fields: { actor: 'Bob', quantity: 'none' } },
    ], extractors: [{ provider: 'codex', model: 'test', prompt_digest: 'a'.repeat(64), at: '2026-10-11T12:00:00Z' }] });
  return { templates, document, inputs };
}
function selected(kind: TrapKind): { trap: Trap } & ReturnType<typeof fixture> {
  const setup = fixture();
  const trap = generateTraps(setup.templates, setup.document, setup.inputs).traps.find(item => item.kind === kind && item.base_unit === 'c1')!;
  expect(trap, `missing ${kind}`).toBeDefined();
  return { ...setup, trap };
}

describe('deterministic traps', () => {
  it('generates all seven kinds, preserves evidence and pins template intent', () => {
    const { templates, document, inputs } = fixture();
    const result = generateTraps(templates, document, inputs, { seed: 'test' });
    expect(new Set(result.traps.map(trap => trap.kind))).toEqual(new Set(trapKinds));
    expect(result.discarded).toBeGreaterThan(0);
    expect(result.rejections).toHaveLength(result.discarded);
    expect(generateTraps(templates, document, inputs, { seed: 'test' })).toEqual(result);
    expect(generateTraps(templates, document, inputs, { seed: 'different' }).traps[0]!.id).not.toBe(result.traps[0]!.id);
    for (const trap of result.traps) {
      expect(trap.validation).toEqual({ valid: true, reasons: [] });
      expect(trap.intended_answers).toHaveProperty(`supported@${trap.base_unit}`);
      expect(trap.instances.every(instance => instance.status === 'ready')).toBe(true);
    }
    expect(inputs.context.evidence).toContain('Alice is paid 1,000 dollars.');
  });
  it('updates atomic fields, spans and cited-row state after mutations', () => {
    const number = selected('number-substitution').trap;
    expect(number.decomposition.units[0]!.fields!.quantity).toBe(number.mutation.value_after);
    expect(number.decomposition.units[0]!.source_span).toContain(number.mutation.value_after);
    expect(number.instances[0]!.instructions).toContain(number.mutation.value_after);
    const entity = selected('entity-substitution').trap;
    expect(entity.decomposition.units[0]!.fields!.actor).toBe('Bob');
    const cite = selected('citation-swap').trap;
    expect(cite.decomposition.units[0]!.cites).toEqual(['R2']);
    expect(cite.instances[0]!.projection['unit.cited_rows']).toEqual([{ id: 'R2', context: 'evidence', text: '## R2\nBob was promoted.' }]);
    const permutation = selected('option-permutation').trap;
    expect(permutation.instances[0]!.options).toEqual(['redundant', 'unsupported', 'supported']);
    expect(permutation.instances[1]!.options).toEqual(['supported', 'unsupported', 'redundant']);
    expect(permutation.intended_answers).toEqual({ 'supported@c1': 'unchanged' });
  });
  it('counts unavailable mutations and refuses invalid base spans', () => {
    const { templates, document, inputs } = fixture();
    document.units[0]!.text = 'invented';
    expect(() => generateTraps(templates, document, inputs)).toThrow('invalid base');
    const clean = fixture(); clean.templates.templates[0]!.traps = {};
    expect(generateTraps(clean.templates, clean.document, clean.inputs).traps).toEqual([]);
    clean.templates.templates[0]!.traps = { 'number-substitution': 'unsupported' };
    clean.templates.templates[0]!.instructions = '{output.missing}';
    expect(generateTraps(clean.templates, clean.document, clean.inputs).rejections[0]!.reason).toBe('no ready affected checks');
  });
  it('does not mutate ambiguous spans, output keys or unavailable neighbors', () => {
    expect(locateSpan({ text: 'a a' }, 'a')).toBeUndefined();
    expect(locateSpan({ match: 'other' }, 'match')).toBeUndefined();
    expect(locateSpan({ value: 'Alpha\n Beta' }, 'Alpha Beta')!.source).toBe('Alpha\n Beta');
    expect(replaceLeaf('before', [], 'after')).toBe('after');
    const { templates, document, inputs } = fixture();
    expect(mutationFor('injected-redundancy', document.units[1]!, document, inputs, templates, '0')).toBeUndefined();
    expect(mutationFor('number-substitution', { ...document.units[0]!, text: 'none' }, document, inputs, templates, '0')).toBeUndefined();
    expect(keyTerms('This was a test with facts.')).toEqual(['test', 'facts']);
  });
  it('handles normalized spans, audit units and refuses collateral span loss', () => {
    const { templates, document, inputs } = fixture();
    document.units[0]!.text = 'Alice is\n paid 1,000 dollars [R1].';
    document.audit = { extractor: document.extractors[0]!, at: document.extractors[0]!.at,
      missed: [{ id: 'short', kind: 'claim', text: 'Alice is paid 1,000 dollars', fields: { actor: 'Alice', quantity: '1,000' }, cites: ['R1'] }] };
    const result = generateTraps(templates, document, inputs);
    expect(result.rejections.some(item => item.reason === 'mutation invalidated another extracted span')).toBe(true);
    expect(result.traps.some(item => item.decomposition.audit?.missed)).toBe(true);
  });
});

describe('independent mutation validation', () => {
  it('rejects no-op, evidence edits and changes outside the selected output leaf', () => {
    const { trap, templates, document, inputs } = selected('number-substitution');
    const check = (change: Partial<Trap>) => validateTrap({ ...trap, ...change }, document.units[0]!, inputs, templates);
    expect(check({ context_digest: 'tampered' }).valid).toBe(false);
    expect(check({ output: inputs.output }).valid).toBe(false);
    expect(check({ mutation: { ...trap.mutation, after: trap.mutation.before } }).valid).toBe(false);
    expect(check({ mutation: { ...trap.mutation, source: 'invented' } }).valid).toBe(false);
    expect(validateTrap(trap, { ...document.units[0]!, text: 'invented' }, inputs, templates).valid).toBe(false);
  });
  it('rejects replacement values already present in evidence, including comma formatting', () => {
    const { trap, templates, document, inputs } = selected('number-substitution');
    const duplicate = structuredClone(inputs);
    duplicate.context.evidence = String(duplicate.context.evidence).replace('## R2', `A value is ${Number(trap.mutation.value_after).toLocaleString('en-US')}.\n## R2`);
    const result = validateTrap(trap, document.units[0]!, duplicate, templates);
    expect(result.reasons).toContain('numeric value already in cited evidence');
    const generated = generateTraps(templates, document, duplicate);
    expect(generated.traps.some(item => item.kind === 'number-substitution' && item.base_unit === 'c1')).toBe(false);
    expect(generated.rejections.some(item => item.reason.includes('numeric value already in cited evidence'))).toBe(true);
    const malformed = { ...trap, mutation: { ...trap.mutation, value_before: 'Alice', value_after: 'word' } };
    expect(validateTrap(malformed, document.units[0]!, inputs, templates).reasons).toContain('invalid numeric substitution');
    const entity = selected('entity-substitution');
    expect(validateTrap({ ...entity.trap, mutation: { ...entity.trap.mutation, value_after: 'Unknown' } }, entity.document.units[0]!, entity.inputs, entity.templates).valid).toBe(false);
    expect(validateTrap({ ...trap, mutation: { ...trap.mutation, value_after: 'Alice' } }, document.units[0]!, inputs, templates).valid).toBe(false);
  });
  it.each(['negation-flip', 'format-paraphrase', 'citation-swap', 'injected-redundancy'] as const)('rejects invalid %s', kind => {
    const { trap, templates, document, inputs } = selected(kind);
    trap.mutation.replacement = 'not the intended replacement';
    trap.mutation.after = 'bad after';
    expect(validateTrap(trap, document.units[0]!, inputs, templates).valid).toBe(false);
  });
  it('rejects an invalid permutation or changed output', () => {
    const { trap, templates, document, inputs } = selected('option-permutation');
    trap.instances[0]!.options.reverse(); trap.mutation.after = trap.mutation.before; trap.output = 'changed';
    expect(validateTrap(trap, document.units[0]!, inputs, templates).reasons).toHaveLength(3);
  });
  it('checks citation target key terms and applies only enumerated harmless controls', () => {
    expect(flipNegation('Alice is not paid.')).toBe('Alice is paid.');
    expect(flipNegation('Run fast.')).toBeUndefined();
    expect(formatParaphrase('ten per cent')).toBe('ten percent');
    expect(formatParaphrase('ten percent')).toBe('ten per cent');
    expect(formatParaphrase('Alice said hello')).toBe('Alice stated hello');
    expect(formatParaphrase('Alice stated hello')).toBe('Alice said hello');
    expect(formatParaphrase('No changes')).toBeUndefined();
    const { trap, templates, document, inputs } = selected('citation-swap');
    inputs.context.evidence += '\nAlice was promoted';
    expect(validateTrap(trap, document.units[0]!, inputs, templates).valid).toBe(false);
  });
});
