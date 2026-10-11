import { expect, it } from 'vitest';
import { stableDigest } from '../format/index.js';
import { generateTraps as generate, validateTrap } from './index.js';
import { fixture } from './fixtures.js';
import { affirmativeCounterpart, articleEntities, entityType, numbers, plausibleNumber } from './preconditions.js';

function generateTraps(...[templates, document, inputs, options]: Parameters<typeof generate>) {
  const baseFinals = Object.fromEntries([...document.units, ...(document.audit?.missed ?? [])].flatMap(unit =>
    templates.templates.filter(template => template.applies_to === unit.kind).map(template => [`${template.id}@${unit.id}`, template.expected[0]!] )));
  return generate(templates, document, inputs, { baseFinals, ...options });
}

it('rejects negation without independently affirmative evidence, including existing negators', () => {
  for (const text of ['Dr Alice is not paid 1,000 dollars [R1].', 'Dr Alice is paid 1,000 dollars [R1].']) {
    const f = fixture();
    f.inputs.output = { body: [text] }; f.document.units = [{ ...f.document.units[0]!, text }];
    if (!text.includes('not')) f.inputs.context.evidence = '## R1\nDr Alice may be paid 1,000 dollars.';
    delete f.document.units[0]!.source_span;
    expect(generateTraps(f.templates, f.document, f.inputs).traps.some(t => t.kind === 'negation-flip')).toBe(false);
  }
  const f = fixture();
  const trap = generateTraps(f.templates, f.document, f.inputs).traps.find(t => t.kind === 'negation-flip')!;
  f.inputs.context.evidence = '## R1\nDr Alice is not paid 1,000 dollars.\n## R2\nDr Bob was promoted.';
  trap.context_digest = stableDigest(f.inputs.context);
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates).reasons).toContain('negation lacks affirmative cited counterpart');
});

it('requires visible repetition in every affected projection', () => {
  const f = fixture();
  f.templates.templates[0]!.state = ['unit', 'unit.cited_rows'];
  const result = generateTraps(f.templates, f.document, f.inputs);
  expect(result.traps.some(t => t.kind === 'injected-redundancy')).toBe(false);
  expect(result.rejections.some(t => t.reason.includes('redundancy invisible'))).toBe(true);
});

it('rejects ungrounded originals and fingerprint numbers while preserving units and scale', () => {
  const f = fixture();
  f.inputs.context.evidence = '## R1\nDr Alice is paid 2,000 dollars.\n## R2\nDr Bob was promoted.';
  delete f.document.units[0]!.source_span;
  expect(generateTraps(f.templates, f.document, f.inputs).traps.some(t => t.kind === 'number-substitution')).toBe(false);
  const valid = fixture();
  const traps = generateTraps(valid.templates, valid.document, valid.inputs).traps.filter(t => t.kind === 'number-substitution');
  expect(traps).toHaveLength(1);
  expect(plausibleNumber(traps[0]!.mutation.value_before!, traps[0]!.mutation.value_after!)).toBe(true);
  expect(traps[0]!.mutation.replacement).toContain('dollars');
  expect(validateTrap(traps[0]!, valid.document.units[0]!, f.inputs, f.templates).reasons).toContain('original number absent from cited evidence');
  const fingerprint = structuredClone(traps[0]!);
  fingerprint.mutation.value_after = '123456';
  expect(validateTrap(fingerprint, valid.document.units[0]!, valid.inputs, valid.templates).reasons).toContain('invalid numeric substitution');
  for (const pair of [['12', '999999'], ['99', '100'], ['1', '2'], ['1.00', '1.1'], ['0', '1'], ['word', '12'], ['12', '12']]) {
    expect(plausibleNumber(pair[0]!, pair[1]!)).toBe(false);
  }
  expect(plausibleNumber('1,000', '1001')).toBe(true);
  expect(plausibleNumber('12.00', '12.01')).toBe(true);
  expect(numbers('R1 has 1,000 and 12.01')).toEqual(['1,000', '12.01']);
  expect(numbers('none')).toEqual([]);
});

it('only substitutes independently typed entities from the article and cited originals', () => {
  expect(entityType('Alice')).toBeUndefined();
  expect(entityType('Dr Alice')).toBe('person');
  expect(entityType('Example Inc')).toBe('organization');
  expect(articleEntities({ body: ['Dr Alice meets Example Inc.'] })).toEqual(['Dr Alice', 'Example Inc.']);
  const f = fixture();
  f.inputs.context.evidence = '## R1\nDr Mallory is paid 1,000 dollars.\n## R2\nDr Bob was promoted.';
  delete f.document.units[0]!.source_span;
  expect(generateTraps(f.templates, f.document, f.inputs).traps.some(t => t.kind === 'entity-substitution' && t.base_unit === 'c1')).toBe(false);
});

it('validates serialized affected population, answers, projections and unit locations', () => {
  const f = fixture();
  const original = generateTraps(f.templates, f.document, f.inputs).traps.find(t => t.kind === 'number-substitution')!;
  for (const modify of [
    (t: typeof original) => { t.intended_answers = {}; },
    (t: typeof original) => { t.decomposition.units.pop(); },
    (t: typeof original) => { t.decomposition.units[0]!.sentence = 4; },
    (t: typeof original) => { t.instances[0]!.instructions = 'invented'; },
    (t: typeof original) => { t.intended_answers['supported@c1'] = 'supported'; },
    (t: typeof original) => { t.decomposition.units[0]!.fields!.actor = 'Alice'; },
  ]) {
    const trap = structuredClone(original); modify(trap);
    expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates, f.document).valid).toBe(false);
  }
  expect(affirmativeCounterpart('Dr Alice is paid [R1].', '## R1\nDr Alice is paid.', f.templates)).toBe(true);
  expect(affirmativeCounterpart('[R1]', 'irrelevant', f.templates)).toBe(false);
});

it('substitutes a whole grounded numeric token and preserves other numbers', () => {
  const f = fixture();
  const text = 'Dr Alice reported 123 and 1.12 before 12 dollars [R1].';
  f.inputs.output = { body: [text] };
  f.document.units = [{ id: 'c1', kind: 'claim', text, paragraph: 0, cites: ['R1'], fields: { actor: 'Dr Alice' } }];
  f.inputs.context.evidence = '## R1\nDr Alice reported 12 dollars.';
  const trap = generateTraps(f.templates, f.document, f.inputs).traps.find(t => t.kind === 'number-substitution')!;
  expect(trap).toBeDefined();
  expect(trap.mutation.replacement).toContain('123 and 1.12');
  const forged = structuredClone(trap);
  forged.mutation.replacement = text.replace('123', '133');
  expect(validateTrap(forged, f.document.units[0]!, f.inputs, f.templates).reasons).toContain('numeric substitution changed a different token');
  expect(affirmativeCounterpart('Dr Alice is paid [R1].', '## R1\nDr Alice is\npaid.', f.templates)).toBe(true);
});

it('independently rejects untyped entity replacements and overlapping citation targets', () => {
  const f = fixture();
  const traps = generateTraps(f.templates, f.document, f.inputs).traps;
  const entity = structuredClone(traps.find(t => t.kind === 'entity-substitution')!);
  entity.mutation.value_after = 'Bob';
  expect(validateTrap(entity, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toContain('unverified same-type entity substitution');
  const citation = structuredClone(traps.find(t => t.kind === 'citation-swap')!);
  f.inputs.context.evidence += '\nDr Alice attends.';
  citation.context_digest = stableDigest(f.inputs.context);
  expect(validateTrap(citation, f.document.units[0]!, f.inputs, f.templates).reasons)
    .toContain('citation replacement has overlapping key terms or invalid row');
});

it('pins extraction metadata across serialized variants independently of lexical eligibility', () => {
  const f = fixture();
  const trap = generateTraps(f.templates, f.document, f.inputs).traps.find(t => t.kind === 'number-substitution')!;
  trap.decomposition.units[0]!.fields!.actor = 'Alice';
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates, f.document).reasons)
    .toContain('variant changed unrelated extraction metadata');
});

it('rejects forged serialized trap citations even though extraction citations are hints', () => {
  const f = fixture();
  const trap = generateTraps(f.templates, f.document, f.inputs).traps.find(item => item.kind === 'number-substitution')!;
  expect(trap).toBeDefined();
  trap.decomposition.units[0]!.cites = ['R2'];
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates, f.document).reasons)
    .toContain('variant citations differ from source');
});
