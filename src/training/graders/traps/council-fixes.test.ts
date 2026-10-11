import { expect, it } from 'vitest';
import { fixture } from './fixtures.js';
import { generateTraps, validateTrap } from './index.js';
import { mutationFor, flipNegation } from './mutations.js';
import { articleEntities, coReferent, withoutHeadings } from './preconditions.js';

const baseFinals = { 'supported@c1': 'supported', 'supported@c2': 'supported' };
it('requires an expected base final before generating any defect', () => {
  const f = fixture();
  for (const finals of [undefined, {}, { 'supported@c1': null }, { 'supported@c1': 'unsupported' }] as (Record<string, string | null> | undefined)[]) {
    const result = generateTraps(f.templates, f.document, f.inputs, { baseFinals: finals });
    expect(result.traps.every(trap => ['option-permutation', 'format-paraphrase'].includes(trap.kind))).toBe(true);
    expect(result.rejections.some(item => item.reason.includes('baseline final'))).toBe(true);
  }
  expect(generateTraps(f.templates, f.document, f.inputs, { baseFinals }).traps.some(trap => trap.kind === 'number-substitution')).toBe(true);
});
it('does not extract numbers from citations or evidence headings and preserves citation tokens', () => {
  const f = fixture();
  f.templates.context.evidence!.rows = { leading_citations: 'keep', heading: '^## (\\d+)', cite: '\\[(\\d+)\\]' };
  f.document.units = [{ id: 'c1', kind: 'claim', text: 'Dr Alice was promoted [12].', paragraph: 0, cites: ['12'], fields: { actor: 'Dr Alice' } }];
  f.inputs.output = { body: [f.document.units[0]!.text] };
  f.inputs.context.evidence = '## 12 source 2024\nDr Alice was promoted.\n## 13 source\nDr Alice was promoted.';
  const mutate = () => mutationFor('number-substitution', f.document.units[0]!, f.document, f.inputs, f.templates, '0');
  expect(mutate()).toBeUndefined();
  f.document.units[0]!.text = 'Dr Alice reported 2024 units [12].';
  f.inputs.output = { body: [f.document.units[0]!.text] };
  expect(mutate()).toBeUndefined();
  expect(withoutHeadings(String(f.inputs.context.evidence), f.templates)).not.toContain('2024');
  f.document.units[0]!.text = '[12] Dr Alice reported 12 units.';
  f.inputs.output = { body: [f.document.units[0]!.text] };
  f.inputs.context.evidence = '## 12\nDr Alice reported 12 units.';
  expect(mutate()!.replacement).toMatch(/^\[12\] Dr Alice reported (11|13) units\.$/);
});
it('rejects swaps with another supporting citation or repeated original citation tokens', () => {
  for (const citations of ['[R1] [R3]', '[R1] [R1]']) {
    const f = fixture();
    f.inputs.context.evidence += '\n## R3\nDr Alice is paid 1,000 dollars.';
    const text = `Dr Alice is paid 1,000 dollars ${citations}.`;
    f.document.units[0]!.text = text;
    f.inputs.output = { body: [text, 'Dr Bob was promoted [R2].'] };
    const result = generateTraps(f.templates, f.document, f.inputs, { baseFinals });
    expect(result.traps.some(trap => trap.base_unit === 'c1' && trap.kind === 'citation-swap')).toBe(false);
  }
  const f = fixture();
  const trap = generateTraps(f.templates, f.document, f.inputs, { baseFinals }).traps.find(t => t.kind === 'citation-swap')!;
  expect(validateTrap(trap, { ...f.document.units[0]!, cites: ['R1', 'R3'] }, f.inputs, f.templates).valid).toBe(false);
});
it.each([
  ['Dr Alice Smith', 'Professor Alice Smith'], ['Mr Alice', 'Ms Alice Smith'],
  ['Acme Corp.', 'Acme Inc.'], ['Acme Ltd', 'Acme Holdings LLC'], ['Prof. Alice Smith', 'Dr Alice Jones'],
])('rejects co-referent entity forms %s / %s', (before, after) => {
  expect(coReferent(before, after)).toBe(true);
  const f = fixture();
  const text = `${before} is paid 1,000 dollars [R1].`;
  f.document.units = [{ id: 'c1', kind: 'claim', text, paragraph: 0, cites: ['R1'], fields: { actor: before } }];
  f.inputs.output = { body: [text, `${after} works elsewhere.`] };
  f.inputs.context.evidence = `## R1\n${before} is paid 1,000 dollars.`;
  expect(generateTraps(f.templates, f.document, f.inputs, { baseFinals }).traps.some(t => t.kind === 'entity-substitution')).toBe(false);
});
it('requires one main-clause auxiliary and participles after has/have/had', () => {
  for (const text of ['The executive who was hired resigned.', 'The firm which was sold closed.',
    'They said that she was hired.', 'When she was hired, Alice resigned.', 'Because she was hired, Alice resigned.',
    'Although she was hired, Alice resigned.', 'If she was hired, Alice resigned.',
    'Alice was hired and is paid.', 'The clinic had three doctors.', 'The clinic has five offices.', 'They have offices.', 'The clinic has red doors.', 'The clinic had a hundred offices.']) {
    expect(flipNegation(text), text).toBeUndefined();
  }
  for (const text of ['Alice has worked.', 'They have sold offices.', 'Alice had been hired.', 'Alice was hired.']) {
    expect(flipNegation(text)).toContain(' not ');
  }
});

it('recognizes complete legal suffixes without matching their shorter prefixes', () => {
  expect(articleEntities('Acme Corporation meets Beta Co. and Gamma Corp.'))
    .toEqual(['Acme Corporation', 'Beta Co.', 'Gamma Corp.']);
});

it('independently rejects changed citation tokens even when the cited row set is unchanged', () => {
  const f = fixture();
  f.templates.context.evidence!.rows = { leading_citations: 'keep', heading: '^## (\\d+)', cite: '\\[(\\d+)\\]' };
  const text = 'Dr Alice reported 12 units [12] [13] [12].';
  f.document.units = [{ id: 'c1', kind: 'claim', text, paragraph: 0, cites: ['12', '13'], fields: { actor: 'Dr Alice' } }];
  f.inputs.output = { body: [text] };
  f.inputs.context.evidence = '## 12\nDr Alice reported 12 units.\n## 13\nDr Alice reported 12 units.';
  const trap = generateTraps(f.templates, f.document, f.inputs, { baseFinals }).traps.find(t => t.kind === 'number-substitution')!;
  expect(trap).toBeDefined();
  trap.mutation.replacement = trap.mutation.replacement.replace('[12].', '[13].');
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toContain('numeric substitution changed a different token');
});
