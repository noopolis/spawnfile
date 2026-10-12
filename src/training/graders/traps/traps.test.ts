import { describe, expect, it } from 'vitest';
import { fixture } from './fixtures.js';
import { trapKinds } from '../decomposition/index.js';
import type { TrapKind } from '../decomposition/index.js';
import { generateTraps as generate, validateTrap } from './index.js';
import type { Trap } from './index.js';
import { formatParaphrase, locateSpan, mutationFor, replaceLeaf } from './mutations.js';

function generateTraps(...[templates, document, inputs, options]: Parameters<typeof generate>) {
  const baseFinals = Object.fromEntries([...document.units, ...(document.audit?.missed ?? [])].flatMap(unit =>
    templates.templates.filter(template => template.applies_to === unit.kind).map(template => [`${template.id}@${unit.id}`, template.expected[0]!] )));
  return generate(templates, document, inputs, { baseFinals, ...options });
}

function selected(kind: TrapKind): { trap: Trap } & ReturnType<typeof fixture> {
  const setup = fixture();
  const trap = generateTraps(setup.templates, setup.document, setup.inputs).traps.find(item => item.kind === kind && item.base_unit === 'c1')!;
  expect(trap, `missing ${kind}`).toBeDefined();
  return { ...setup, trap };
}

describe('deterministic traps', () => {
  it('generates all three supported kinds, preserves evidence and pins template intent', () => {
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
    expect(inputs.context.evidence).toContain('Dr Alice is paid 1,000 dollars.');
  });
  it('updates atomic fields, spans and cited-row state after mutations', () => {
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
    clean.templates.templates[0]!.traps = { 'format-paraphrase': 'unchanged' };
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
    expect(mutationFor('format-paraphrase', { ...document.units[0]!, text: 'none' }, document, inputs, templates, '0')).toBeUndefined();
  });
  it('handles normalized spans, audit units and refuses collateral span loss', () => {
    const { templates, document, inputs } = fixture();
    document.units[0]!.text = 'Dr Alice is\n paid 1,000 dollars [R1].';
    document.audit = { extractor: document.extractors[0]!, at: document.extractors[0]!.at,
      missed: [{ id: 'short', kind: 'claim', text: 'Dr Alice is paid 1,000 dollars', fields: { actor: 'Dr Alice', quantity: '1,000' }, cites: ['R1'] }] };
    const result = generateTraps(templates, document, inputs);
    expect(result.rejections.some(item => item.reason === 'mutation invalidated another extracted span')).toBe(true);
    expect(result.traps.some(item => item.decomposition.audit?.missed)).toBe(true);
  });
});

describe('independent mutation validation', () => {
  it('rejects no-op, evidence edits and changes outside the selected output leaf', () => {
    const { trap, templates, document, inputs } = selected('format-paraphrase');
    const check = (change: Partial<Trap>) => validateTrap({ ...trap, ...change }, document.units[0]!, inputs, templates);
    expect(check({ context_digest: 'tampered' }).valid).toBe(false);
    expect(check({ output: inputs.output }).valid).toBe(false);
    expect(check({ mutation: { ...trap.mutation, after: trap.mutation.before } }).valid).toBe(false);
    expect(check({ mutation: { ...trap.mutation, source: 'invented' } }).valid).toBe(false);
    expect(validateTrap(trap, { ...document.units[0]!, text: 'invented' }, inputs, templates).valid).toBe(false);
  });
  it.each(['format-paraphrase', 'injected-redundancy'] as const)('rejects invalid %s', kind => {
    const { trap, templates, document, inputs } = selected(kind);
    trap.mutation.replacement = 'not the intended replacement';
    trap.mutation.after = 'bad after';
    expect(validateTrap(trap, document.units[0]!, inputs, templates).valid).toBe(false);
  });
  it('rejects an invalid permutation or changed output', () => {
    const { trap, templates, document, inputs } = selected('option-permutation');
    trap.instances[0]!.options.reverse(); trap.mutation.after = trap.mutation.before; trap.output = 'changed';
    expect(validateTrap(trap, document.units[0]!, inputs, templates).valid).toBe(false);
  });
  it('applies only enumerated harmless controls', () => {
    expect(formatParaphrase('ten per cent')).toBe('ten percent');
    expect(formatParaphrase('ten percent')).toBe('ten per cent');
    expect(formatParaphrase('Dr Alice said hello')).toBe('Dr Alice stated hello');
    expect(formatParaphrase('Dr Alice stated hello')).toBe('Dr Alice said hello');
    expect(formatParaphrase('No changes')).toBeUndefined();

  });
});
