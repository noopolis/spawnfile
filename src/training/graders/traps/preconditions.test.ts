import { expect, it } from 'vitest';
import { generateTraps as generate, validateTrap } from './index.js';
import { fixture } from './fixtures.js';
function generateTraps(...[templates, document, inputs, options]: Parameters<typeof generate>) {
  const baseFinals = Object.fromEntries([...document.units, ...(document.audit?.missed ?? [])].flatMap(unit =>
    templates.templates.filter(template => template.applies_to === unit.kind).map(template => [`${template.id}@${unit.id}`, template.expected[0]!] )));
  return generate(templates, document, inputs, { baseFinals, ...options });
}

it('requires visible repetition in every affected projection', () => {
  const f = fixture();
  f.templates.templates[0]!.state = ['unit', 'unit.cited_rows'];
  const result = generateTraps(f.templates, f.document, f.inputs);
  expect(result.traps.some(t => t.kind === 'injected-redundancy')).toBe(false);
  expect(result.rejections.some(t => t.reason.includes('redundancy invisible'))).toBe(true);
});

it('validates serialized affected population, answers, projections and unit locations', () => {
  const f = fixture();
  const original = generateTraps(f.templates, f.document, f.inputs).traps.find(t => t.kind === 'format-paraphrase')!;
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
});

it('pins extraction metadata across serialized variants independently of lexical eligibility', () => {
  const f = fixture();
  const trap = generateTraps(f.templates, f.document, f.inputs).traps.find(t => t.kind === 'format-paraphrase')!;
  trap.decomposition.units[0]!.fields!.actor = 'Alice';
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates, f.document).reasons)
    .toContain('variant changed unrelated extraction metadata');
});

it('rejects forged serialized trap citations even though extraction citations are hints', () => {
  const f = fixture();
  const trap = generateTraps(f.templates, f.document, f.inputs).traps.find(item => item.kind === 'format-paraphrase')!;
  expect(trap).toBeDefined();
  trap.decomposition.units[0]!.cites = ['R2'];
  expect(validateTrap(trap, f.document.units[0]!, f.inputs, f.templates, f.document).reasons)
    .toContain('variant citations differ from source');
});
